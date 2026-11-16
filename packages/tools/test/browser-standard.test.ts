import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, GuardrailsSchema, contentHash } from '@crosscheck/core';
import * as tools from '../src/index';

const meta = { actionId: 'a-1', phase: 'execution' as const };
describe('标准浏览器动作入口', () => {
  it('仅提供结构化 browser_action，拒绝 evaluate、缺失定位器及额外路径参数', () => {
    expect(tools).toHaveProperty('BrowserHost');
    expect(tools).toHaveProperty('createBrowserTools');
    const host = {} as InstanceType<typeof tools.BrowserHost>;
    const list = tools.createBrowserTools(host, () => meta);
    expect(list.map(t => [t.name, t.category])).toEqual([['browser_action', 'browser']]);
    const schema = list[0]!.input;
    for (const invalid of [{ kind: 'evaluate', script: '1' }, { kind: 'click' }, { kind: 'observe', path: 'x.png' }, { kind: 'fill', locator: { strategy: 'css', value: '#x' }, value: 'x', env: 'TOKEN' }, { kind: 'fill', locator: { strategy: 'css', value: '#x' } }, { kind: 'click', locator: { strategy: 'role', value: 'not-a-role' } }]) expect(schema.safeParse(invalid).success).toBe(false);
    for (const strategy of ['css', 'role', 'text', 'testId', 'xpath']) expect(schema.safeParse({ kind: 'click', locator: { strategy, value: strategy === 'role' ? 'button' : 'x' } }).success).toBe(true);
  });
  it('批准 screenshotMasks 可选且不改变旧审批哈希，修改选择器使哈希变化', () => {
    const previous = { allowedHosts: ['localhost'], forbidden: [], redactFields: [] };
    const parsed = GuardrailsSchema.parse(previous);
    expect(contentHash(parsed)).toBe(contentHash(previous));
    const masked = GuardrailsSchema.parse({ ...previous, screenshotMasks: ['#secret'] });
    expect(masked).toHaveProperty('screenshotMasks', ['#secret']);
    expect(contentHash(masked)).not.toBe(contentHash(parsed));
    expect(contentHash(GuardrailsSchema.parse({ ...previous, screenshotMasks: ['#other'] }))).not.toBe(contentHash(masked));
  });
  it('敏感输入保留可操作定位信息但不保留值', () => {
    expect(tools.sanitizeDom([{ tag: 'input', type: 'password', name: 'password', value: 'never-write', locator: { strategy: 'css', value: 'input:nth-of-type(1)' } }], tools.createEvidenceRedactor())).toEqual([{ tag: 'input', type: 'password', name: 'password', omitted: true, locator: { strategy: 'css', value: 'input:nth-of-type(1)' } }]);
  });
  it('DOM 二次清洗仍保留省略标志，console 源省略不能声称完整', async () => {
    const r = tools.createEvidenceRedactor();
    expect(tools.sanitizeDom([{ tag: 'iframe', omitted: true }], r)).toEqual([{ tag: 'iframe', omitted: true }]);
    const root = await mkdtemp(path.join(tmpdir(), 'cc-browser-incomplete-'));
    try {
      const store = new tools.EvidenceStore(new ArtifactStore(root), { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 }, r);
      const record = await store.saveText('console', '[omitted: 12 console events]', meta);
      expect((await store.readTextEvidence(record.id)).sourceIncomplete).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('R9 DOM omitted 与局部超限表示观察缺失，单纯已知值替换不是缺失', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cc-dom-completeness-'));
    try {
      const store = new tools.EvidenceStore(new ArtifactStore(root), { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 }, tools.createEvidenceRedactor());
      for (const node of [{ tag: 'input', omitted: true }, { tag: 'section', incomplete: true }, { tag: 'div', children: [{ tag: 'canvas', omitted: true }] }]) {
        const record = await store.saveDom([node], meta);
        expect((await store.readTextEvidence(record.id)).sourceIncomplete).toBe(true);
      }
      const record = await store.saveDom([{ tag: 'span', text: '[REDACTED]' }], meta);
      expect((await store.readTextEvidence(record.id)).sourceIncomplete).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('DOM 可按归属 ID 读取，拒绝伪造截图能力和跨 case 读取', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cc-browser-store-'));
    try {
      const artifacts = new ArtifactStore(root), r = tools.createEvidenceRedactor();
      const store = new tools.EvidenceStore(artifacts, { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 }, r);
      const dom = await store.saveDom([{ tag: 'button', text: '保存' }], meta);
      expect(await store.readTextEvidence(dom.id)).toMatchObject({ type: 'dom', sourceIncomplete: false });
      await expect(store.saveScreenshot({ kind: 'masked-capture', complete: true, bytes: Buffer.from('fake') }, meta)).rejects.toThrow();
      const other = new tools.EvidenceStore(artifacts, { runId: 'run-1', caseId: 'M-TC-2', attempt: 1 }, r);
      await expect(other.readTextEvidence(dom.id)).rejects.toThrow();
      await expect(store.readScreenshotEvidence(dom.id)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
