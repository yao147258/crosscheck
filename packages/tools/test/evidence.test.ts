import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../../core/src/index';
import { EvidenceStore, sanitizeHar, sanitizeDom, createEvidenceRedactor } from '../src/index';

const secret = 'sentinel+secret/42';
const ctx = { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 };
const meta = { actionId: 'a-1', phase: 'execution' as const };

describe('可信证据出口', () => {
  it('HAR 各字段安全清理且不修改原始输入', () => {
    const r = createEvidenceRedactor([], [secret]);
    const har = { log: { version: '1.2', creator: { name: 'test', version: '1' }, entries: [{ request: { method: 'POST', url: `/a?session=${secret}#/p?sid=${secret}`, headers: [{ name: 'Authorization', value: secret }], cookies: [{ name: 'sid', value: secret }], queryString: [{ name: 'session', value: secret }], postData: { mimeType: 'application/json', text: '{"password":"unknown",' } }, response: { status: 302, headers: [{ name: 'Location', value: `/x?token=${secret}` }], cookies: [{ name: 'auth', value: secret }], redirectURL: `/x?token=${secret}`, content: { mimeType: 'application/json', text: Buffer.from(JSON.stringify({ token: secret, ok: 1 })).toString('base64'), encoding: 'base64', size: 100 } } }] } };
    const original = JSON.stringify(har);
    const output = JSON.stringify(sanitizeHar(har, r));
    expect(JSON.stringify(har)).toBe(original);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(Buffer.from(JSON.stringify({ token: secret, ok: 1 })).toString('base64'));
    expect(output).not.toContain('unknown');
    expect(output).toContain('omitted');
  });
  it('最终修复 I2 展示JSON按叶子清洗转义的known secret且保留自然语言', () => {
    const dynamic = 'late"secret\\value'; const r = createEvidenceRedactor([], [dynamic]);
    const input = JSON.stringify({ ordinary: dynamic, nested: { url: '/reset?password=UNKNOWN_SECRET&mode=safe' }, password: 'JSON_SECRET', safe: '自然语言不是URL' });
    const clean = JSON.parse(r.displayText(input));
    expect(clean.ordinary).toBe('[REDACTED]'); expect(clean.password).toBe('[REDACTED]'); expect(clean.nested.url).not.toContain('UNKNOWN_SECRET'); expect(clean.nested.url).toContain('mode=safe'); expect(clean.safe).toBe('自然语言不是URL');
    expect(r.displayText('自然语言不是URL')).toBe('自然语言不是URL');
  });
  it.each(["'", '"', '`', '<', '>', '(),;!$:+/?', '%27', '%22%60%3C%3E'])('残留I2 URL边界%s保持嵌套JSON/quoted URL语义和自然语言', boundary => {
    const r = createEvidenceRedactor();
    const url = `https://example.invalid/reset?password=before${boundary}AFTER_SECRET_918&mode=safe`;
    const nested = JSON.parse(r.displayText(JSON.stringify({ url, nested: { note: `请检查 ${url} 然后继续`, encoded: JSON.stringify({ url, safe: '安全值' }) } })));
    expect(JSON.stringify(nested)).not.toContain('AFTER_SECRET_918');
    for (const clean of [nested.url, nested.nested.note, JSON.parse(nested.nested.encoded).url, r.displayText(`请检查 "${url}" 然后继续`), r.displayText(`请检查 '${url}' 然后继续`), r.displayText(`请检查 \`${url}\` 然后继续`)]) {
      expect(clean).not.toContain('AFTER_SECRET_918'); expect(clean).toContain('/reset'); expect(clean).toContain('mode=safe');
    }
    expect(nested.nested.note).toContain('请检查'); expect(nested.nested.note).toContain('然后继续'); expect(JSON.parse(nested.nested.encoded).safe).toBe('安全值');
    expect(r.displayText('仅自然语言，没有URL')).toBe('仅自然语言，没有URL');
    expect(r.usage({ inputTokens: 12, outputTokens: 8, pricingKnown: true, cost: 0 })).toEqual({ inputTokens: 12, outputTokens: 8, pricingKnown: true, cost: 0 });
  });
  it('残留I2 URL token内的JSON形状标点不能拆成脱敏范围外的片段', () => {
    const r = createEvidenceRedactor();
    const input = '请检查 https://example.invalid/reset?password=before{"safe":"AFTER_SECRET_918"}&mode=safe 然后继续';
    const clean = r.displayText(input);
    expect(clean).not.toContain('AFTER_SECRET_918');
    for (const safe of ['请检查', '/reset', 'mode=safe', '然后继续']) expect(clean).toContain(safe);
  });
  it('遮蔽敏感 DOM 和不可验证区域', () => {
    const r = createEvidenceRedactor([], [secret]);
    const dom = sanitizeDom([{ tag: 'input', type: 'password', value: 'unknown' }, { tag: 'div', text: secret }, { tag: 'iframe', text: 'unseen' }, { tag: 'span', text: 'safe' }], r);
    expect(JSON.stringify(dom)).not.toMatch(/unknown|sentinel|unseen/);
    expect(JSON.stringify(dom)).toContain('safe');
  });
  it('先保存内容后索引并核验归属、摘要和缺失，完整目录不含哨兵', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'evidence-'));
    try {
      const artifacts = new ArtifactStore(root);
      const store = new EvidenceStore(artifacts, ctx, createEvidenceRedactor([], [secret]));
      const record = await store.saveText('console', `error ${secret}`, meta);
      expect((await store.verify(record)).toString()).not.toContain(secret);
      await expect(store.verify({ ...record, caseId: 'M-TC-2' })).rejects.toThrow();
      await expect(store.verify({ ...record, redacted: false })).rejects.toThrow();
      await expect(store.verify({ ...record, id: 'e-fake' })).rejects.toThrow();
      const trace = store.sanitizeTrace({ ...ctx, actionId: 'a-1', phase: 'execution', time: '2026-11-13T00:00:00Z', event: 'error', message: `failed ${secret}`, action: { type: 'fill', locator: null, input: { kind: 'secretRef', env: 'PASSWORD_ENV' } }, beforeEvidenceIds: [], afterEvidenceIds: [], result: { status: 'error', output: { message: secret }, error: secret }, durationMs: 1 });
      expect(JSON.stringify(trace)).not.toContain(secret);
      expect(trace.action.input).toEqual({ kind: 'secretRef', env: 'PASSWORD_ENV' });
      await store.saveHar({ log: { version: '1.2', creator: { name: 'fixture', version: '1' }, entries: [{ startedDateTime: '2026-11-13T00:00:00Z', time: 42, request: { method: 'POST', url: `/x?session=${secret}`, headers: [{ name: 'Authorization', value: secret }], cookies: [{ name: 'sid', value: secret }], queryString: [{ name: 'sid', value: secret }], postData: { mimeType: 'application/json', text: '{"password":"oops"' } }, response: { status: 302, redirectURL: `/x?token=${secret}`, headers: [{ name: 'Location', value: `/x?token=${secret}` }], cookies: [{ name: 'x', value: secret }], content: { mimeType: 'application/json', encoding: 'base64', text: Buffer.from(JSON.stringify({ password: secret, value: 1 })).toString('base64'), size: 25 } } }] } }, meta);
      const binary = JSON.stringify(sanitizeHar({ log: { entries: [{ response: { content: { mimeType: 'application/octet-stream', text: Buffer.from(secret).toString('base64'), encoding: 'base64' } } }] } }, createEvidenceRedactor([], [secret])));
      expect(binary).toContain('omitted');
      expect(binary).not.toContain(secret);
      expect(createEvidenceRedactor([], [secret]).usage({ inputTokens: 12, outputTokens: 8, pricingKnown: true, cost: 0 })).toEqual({ inputTokens: 12, outputTokens: 8, pricingKnown: true, cost: 0 });
      await store.saveDom([{ tag: 'input', type: 'password', value: secret }], meta);
      await expect(store.verify({ ...record, digest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow();
      await expect(store.saveScreenshot(Buffer.from(secret), meta)).rejects.toThrow();
      const walk = async (dir: string): Promise<string> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async e => e.isDirectory() ? walk(path.join(dir, e.name)) : (await readFile(path.join(dir, e.name))).toString()))).join('\n');
      expect(await walk(path.join(root, '.crosscheck'))).not.toContain(secret);
      await artifacts.remove(record.path);
      await expect(store.verify(record)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
