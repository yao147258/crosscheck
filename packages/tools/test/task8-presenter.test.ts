import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, BudgetTracker } from '@crosscheck/core';
import { prepareContext, runAgent } from '@crosscheck/agent';
import { scriptedModel } from '../../agent/src/testing/scripted-model';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { EvidenceStore, createEvidencePresenter, createEvidenceRedactor } from '../src/index';
const context = { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 };
const meta = { actionId: 'a-1', phase: 'execution' as const };

describe('Task8 宿主证据 presenter', () => {
  it.each(['db-truncated', 'request-truncated', 'response-truncated', 'request-omitted', 'response-omitted', 'request-encoding-omitted', 'response-encoding-omitted', 'complete-db', 'complete-har'] as const)('源完整性 %s 在短正文中传到真实 SDK 与 finish 门禁', async kind => {
    const root = await mkdtemp(path.join(tmpdir(), 'presenter-completeness-'));
    try {
      const store = new EvidenceStore(new ArtifactStore(root), context, createEvidenceRedactor());
      const request = { method: 'POST', url: 'https://example.invalid/', postData: { mimeType: 'application/json', text: '{"actual":1}', ...(kind === 'request-truncated' ? { truncated: true } : {}), ...(kind === 'request-omitted' ? { mimeType: 'application/octet-stream' } : {}), ...(kind === 'request-encoding-omitted' ? { mimeType: 'text/plain', encoding: 'unsupported' } : {}) } };
      const response = { status: 200, content: { mimeType: 'application/json', text: '{"actual":1}', ...(kind === 'response-truncated' ? { truncated: true } : {}), ...(kind === 'response-omitted' ? { mimeType: 'application/octet-stream' } : {}), ...(kind === 'response-encoding-omitted' ? { mimeType: 'text/plain', encoding: 'unsupported' } : {}) } };
      const record = kind.endsWith('db') || kind === 'db-truncated'
        ? await store.saveJson('db', { status: 'success', sent: true, rows: [{ value: 1, truncated: true, omitted: true }], truncated: kind === 'db-truncated', notice: kind === 'db-truncated' ? '查询结果已截断，不能用于完整集合结论' : '' }, meta)
        : await store.saveHar({ log: { entries: [{ request, response }] } }, meta);
      const incomplete = !kind.startsWith('complete');
      const source = await store.readTextEvidence(record.id);
      expect(source.text.length).toBeLessThan(16000);
      expect(source.sourceIncomplete).toBe(incomplete);
      const presenter = createEvidencePresenter(store);
      const presented = await presenter([record.id], { ref: 'mock:a', signal: new AbortController().signal });
      expect(presented[0]!.truncated).toBe(incomplete);
      if (!kind.endsWith('db') && kind !== 'db-truncated') {
        const text = presented[0]!;
        if (text.type === 'screenshot') throw new Error('期望文本证据');
        const har = JSON.parse(text.text);
        const body = kind.startsWith('request') ? har.log.entries[0].request.postData : har.log.entries[0].response.content;
        expect(body.omitted).toBe(incomplete);
        expect(body.truncated).toBe(kind.endsWith('truncated'));
      }
      const prepared = await prepareContext([{ role: 'user', content: '条款原文与预期' }], { presenter, requiredEvidenceIds: [record.id], ref: 'mock:a', signal: new AbortController().signal });
      expect(prepared.incompleteEvidenceIds).toEqual(incomplete ? [record.id] : []);
      const model = scriptedModel(Array.from({ length: 3 }, () => ({ toolCalls: [{ name: 'finish', input: { answer: 'PASS' } }] })));
      const result = await runAgent({ stage: 'review', system: '只按条款原文', messages: [{ role: 'user', content: '条款原文与预期' }], tools: [], output: z.object({ answer: z.string() }),
        models: [{ ref: 'mock:a', model }], evidencePresenter: presenter, requiredEvidenceIds: [record.id], budget: new BudgetTracker({ steps: 10, tokens: 10000, minutes: 1 }) });
      expect(result).toMatchObject(incomplete ? { status: 'blocked', reason: 'invalid-output', steps: 3 } : { status: 'done', steps: 1 });
      expect(model.doGenerateCalls).toHaveLength(incomplete ? 3 : 1);
      for (const call of model.doGenerateCalls) {
        expect(JSON.stringify(call.prompt)).toContain(record.id);
        if (incomplete) expect(JSON.stringify(call.prompt)).toContain('[宿主证据不完整 truncated]');
        else expect(JSON.stringify(call.prompt)).not.toContain('[宿主证据不完整 truncated]');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('HAR 内嵌 JSON 在落盘后动态清洗转义秘密，主/重试/备用解码后都无法恢复', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'presenter-late-secret-'));
    try {
      const secret = 'late"secret\\value';
      const safe = '正常"引号\\路径';
      const redactor = createEvidenceRedactor();
      const store = new EvidenceStore(new ArtifactStore(root), context, redactor);
      const record = await store.saveHar({ log: { creator: { name: secret }, entries: [{ request: { method: 'POST', url: `https://example.invalid/?actual=${encodeURIComponent(secret)}`, headers: [{ name: 'X-Actual', value: secret }], postData: { mimeType: 'application/json', text: JSON.stringify({ actual: secret, safe }) } }, response: { status: 200, statusText: secret, headers: [{ name: 'X-Actual', value: secret }], content: { mimeType: 'application/json', text: JSON.stringify({ actual: secret, safe }) } } }] } }, meta);
      const before = JSON.parse((await store.verify(record)).toString('utf8'));
      expect(JSON.parse(before.log.entries[0].response.content.text).actual).toBe(secret);
      redactor.addSecrets([secret]);
      const primary = scriptedModel([{ error: new Error('down') }, { error: new Error('down') }]);
      const backup = scriptedModel([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
      const result = await runAgent({ stage: 'review', system: '仅按条款', messages: [{ role: 'user', content: '条款与预期' }], tools: [], output: z.object({ answer: z.string() }),
        models: [{ ref: 'mock:primary', model: primary }, { ref: 'mock:backup', model: backup }], evidencePresenter: createEvidencePresenter(store), requiredEvidenceIds: [record.id], budget: new BudgetTracker({ steps: 10, tokens: 10000, minutes: 1 }), resilience: { retries: 1, sleep: async () => {} } });
      expect(result.status).toBe('done');
      const calls = [...primary.doGenerateCalls, ...backup.doGenerateCalls];
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        const parts = call.prompt.flatMap(message => message.role === 'user' ? message.content : []);
        const part = parts.find(part => part.type === 'text' && part.text.startsWith(`[宿主证据 ${record.id}]`));
        if (!part || part.type !== 'text') throw new Error('没有证据附件');
        const har = JSON.parse(part.text.slice(part.text.indexOf('{')));
        const entry = har.log.entries[0];
        for (const body of [entry.request.postData, entry.response.content]) {
          expect(JSON.parse(body.text)).toEqual({ actual: '[REDACTED]', safe });
          expect(body.omitted).toBe(false);
          expect(body.truncated).toBe(false);
        }
        expect(har.log.creator.name).toBe('[REDACTED]');
        expect(new URL(entry.request.url).searchParams.get('actual')).toBe('[REDACTED]');
        expect(entry.request.headers[0].value).toBe('[REDACTED]');
        expect(entry.response.headers[0].value).toBe('[REDACTED]');
        expect(entry.response.statusText).toBe('[REDACTED]');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('真实仓库到 SDK 主备输入均为脱敏原始证据，不含 executor 哨兵', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'presenter-sdk-'));
    try {
      const store = new EvidenceStore(new ArtifactStore(root), context, createEvidenceRedactor([], ['private-secret']));
      const db = await store.saveJson('db', { status: 'success', sent: true, rows: [{ actual: '实测值', password: 'private-secret' }], truncated: false }, meta);
      const primary = scriptedModel([{ error: new Error('down') }, { error: new Error('down') }]);
      const backup = scriptedModel([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
      const executorJudgement = { reasoning: 'EXECUTOR_CONCLUSION_SENTINEL', verdict: 'pass' };
      expect(executorJudgement.reasoning).toBeTruthy();
      const result = await runAgent({ stage: 'review', system: '仅条款原文和预期判定', messages: [{ role: 'user', content: '原文：实际值为实测值；预期：实测值' }], tools: [], output: z.object({ answer: z.string() }),
        models: [{ ref: 'mock:primary', model: primary }, { ref: 'mock:backup', model: backup }], evidencePresenter: createEvidencePresenter(store), requiredEvidenceIds: [db.id],
        budget: new BudgetTracker({ steps: 10, tokens: 10000, minutes: 1 }), resilience: { retries: 1, sleep: async () => {} } });
      expect(result.status).toBe('done');
      for (const call of [...primary.doGenerateCalls, ...backup.doGenerateCalls]) {
        const input = JSON.stringify(call.prompt);
        expect(input).toContain('实测值');
        expect(input).toContain('rows');
        expect(input).toContain('REDACTED');
        expect(input).not.toContain('private-secret');
        expect(input).not.toContain('EXECUTOR_CONCLUSION_SENTINEL');
        expect(input).not.toContain('actionId');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('仅受控读取已登记 network/db/console，动态脱敏并明确截断', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'presenter-'));
    try {
      const artifacts = new ArtifactStore(root);
      const redactor = createEvidenceRedactor();
      const store = new EvidenceStore(artifacts, context, redactor);
      const db = await store.saveJson('db', { rows: [{ actual: 'secret-later' }] }, meta);
      const consoleRecord = await store.saveText('console', '真实控制台 ' + 'x'.repeat(500), meta);
      const network = await store.saveHar({ log: { entries: [{ request: { method: 'GET', url: 'https://example.invalid/' }, response: { status: 200, content: { mimeType: 'text/plain', text: '真实响应' } } }] } }, meta);
      redactor.addSecrets(['secret-later']);
      const present = createEvidencePresenter(store, { maxTextChars: 200 });
      const rows = await present([db.id, consoleRecord.id, network.id], { ref: 'mock:a', signal: new AbortController().signal });
      expect(rows.map(row => row.type)).toEqual(['db', 'console', 'network']);
      expect(JSON.stringify(rows)).not.toContain('secret-later');
      const dbText = rows[0]!, consoleText = rows[1]!;
      if (dbText.type === 'screenshot' || consoleText.type === 'screenshot') throw new Error('期望文本证据');
      expect(dbText.text).toContain('REDACTED');
      expect(consoleText).toMatchObject({ truncated: true });
      expect(consoleText.text.length).toBeLessThanOrEqual(200);
      expect(consoleText.text).toContain('truncated');
      expect(JSON.stringify(rows)).not.toContain('actionId');
      await expect(present([db.path], { ref: 'mock:a', signal: new AbortController().signal })).rejects.toThrow();
      const foreign = new EvidenceStore(artifacts, { ...context, attempt: 2 }, redactor);
      await expect(createEvidencePresenter(foreign)([db.id], { ref: 'mock:a', signal: new AbortController().signal })).rejects.toThrow();
      const dom = await store.saveDom([{ tag: 'div', text: '真实DOM' }], meta);
      expect(await present([dom.id], { ref: 'mock:a', signal: new AbortController().signal })).toEqual([{ id: dom.id, type: 'dom', text: '[{"tag":"div","text":"真实DOM"}]', truncated: false }]);
      await artifacts.writeJson(db.path, { forged: true });
      await expect(present([db.id], { ref: 'mock:a', signal: new AbortController().signal })).rejects.toThrow(/摘要/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('预中止不读证据，非法大小上限立即拒绝', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'presenter-'));
    try {
      const store = new EvidenceStore(new ArtifactStore(root), context, createEvidenceRedactor());
      expect(() => createEvidencePresenter(store, { maxTextChars: 0 })).toThrow();
      await expect(createEvidencePresenter(store)(['missing'], { ref: 'mock:a', signal: AbortSignal.abort(new Error('取消')) })).rejects.toThrow('取消');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
