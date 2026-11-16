import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, BudgetTracker, EvidenceRecordSchema, type EvidenceRecord } from '@crosscheck/core';
import { prepareContext, runAgent, type EvidencePresentation } from '@crosscheck/agent';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { scriptedModel } from '../../agent/src/testing/scripted-model';
import { buildReviewInput } from '../../runner/src/review-input';
import { validateJudgements } from '../../runner/src/judgement';
import { EvidenceStore, createEvidencePresenter, createEvidenceRedactor } from '../src/index';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const context = { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 };
const meta = { actionId: 'a-1', phase: 'execution' as const };
const prefix = 'runs/run-1/cases/M-TC-1/attempts/1';
const signal = () => new AbortController().signal;
const finish = { toolCalls: [{ name: 'finish', input: { answer: 'PASS' } }] };
async function fixture(work: (store: EvidenceStore, artifacts: ArtifactStore, image: EvidenceRecord) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-presentation-'));
  try {
    const artifacts = new ArtifactStore(root);
    const store = new EvidenceStore(artifacts, context, createEvidenceRedactor());
    // 直接构造已登记工件测试读取边界，不伪造可信截图采集能力。
    const image = EvidenceRecordSchema.parse({ ...context, ...meta, id: 'e-png', type: 'screenshot', mime: 'image/png', time: new Date().toISOString(), path: `${prefix}/evidence/files/e-png.png`, digest: `sha256:${createHash('sha256').update(png).digest('hex')}`, redacted: true });
    await artifacts.writeBytes(image.path, png);
    await artifacts.writeJson(`${prefix}/evidence/index.json`, [image]);
    await work(store, artifacts, image);
  } finally { await rm(root, { recursive: true, force: true }); }
}
function budget() { return new BudgetTracker({ steps: 20, tokens: 10000, minutes: 1 }); }
const clauses = [{ id: 'M-AC-1', text: '原文', source: { file: '需求.md', line: 1, excerpt: '原文' } }];
const expectations = [{ id: 'E1', text: '页面正确', evidence: ['screenshot' as const, 'dom' as const] }];

describe('Task2 浏览器证据真实呈现', () => {
  it('每个候选按图片能力装配真实PNG，fallback无图且清空首选shown，DOM全文进入SDK', async () => fixture(async (store, _artifacts, image) => {
    const dom = await store.saveDom([{ tag: 'button', text: 'DOM全文_真实保存按钮', locator: { strategy: 'css', value: '#save' } }], meta);
    const primary = scriptedModel([{ error: new Error('primary down') }]);
    const backup = scriptedModel([finish, finish, finish]);
    const shown = new Map<string, EvidencePresentation>();
    const events: { ref: string; evidence: readonly EvidencePresentation[] }[] = [];
    const result = await runAgent({ stage: 'review', models: [{ ref: 'mock:image', model: primary }, { ref: 'mock:text', model: backup }], system: '独立审查',
      messages: buildReviewInput(clauses, expectations, [image.id, dom.id]), tools: [], output: z.object({ answer: z.string() }), budget: budget(), resilience: { retries: 0 },
      evidencePresenter: createEvidencePresenter(store, { capabilities: { 'mock:image': { images: true } } }), requiredEvidenceIds: [image.id, dom.id],
      onEvidencePresented: async event => { await Promise.resolve(); shown.clear(); event.evidence.forEach(e => shown.set(e.id, e)); events.push(event); },
    });
    expect(result).toMatchObject({ status: 'blocked', reason: 'invalid-output' });
    expect(events[0]).toMatchObject({ ref: 'mock:image', evidence: [{ id: image.id, type: 'screenshot', truncated: false }, { id: dom.id, type: 'dom', truncated: false }] });
    expect(shown.has(image.id)).toBe(false);
    expect(shown.get(dom.id)).toMatchObject({ truncated: false });
    const parts = primary.doGenerateCalls[0]!.prompt.flatMap(m => m.role === 'user' ? m.content : []);
    // SDK把公开ModelMessage的image part规范化为provider的file part。
    const file = parts.find(p => p.type === 'file');
    expect(file).toMatchObject({ type: 'file', mediaType: 'image/png' });
    if (file?.type !== 'file' || file.data.type !== 'data' || !(file.data.data instanceof Uint8Array)) throw new Error('未送入真实PNG bytes');
    expect(Buffer.from(file.data.data)).toEqual(png);
    for (const call of backup.doGenerateCalls) {
      expect(call.prompt.flatMap(m => m.role === 'user' ? m.content : []).some(p => p.type === 'file')).toBe(false);
      expect(JSON.stringify(call.prompt)).toContain('DOM全文_真实保存按钮');
      expect(JSON.stringify(call.prompt)).toContain('宿主证据不完整');
      expect(JSON.stringify(call.prompt)).not.toContain('actionId');
    }
  }));
  it('未配置images默认无图，仍核验截图；读盘失败原样传播且不provider重试', async () => fixture(async (store, artifacts, image) => {
    const presenter = createEvidencePresenter(store);
    expect(await presenter([image.id], { ref: 'mock:a', signal: signal() })).toEqual([]);
    await artifacts.writeBytes(image.path, Buffer.from('tampered'));
    const primary = scriptedModel([finish]), fallback = scriptedModel([finish]);
    await expect(runAgent({ stage: 'review', models: [{ ref: 'mock:a', model: primary }, { ref: 'mock:b', model: fallback }], system: '原文', messages: [], tools: [], output: z.object({ answer: z.string() }), budget: budget(),
      evidencePresenter: presenter, requiredEvidenceIds: [image.id], resilience: { retries: 2, sleep: async () => {} } })).rejects.toThrow(/摘要/);
    expect(primary.doGenerateCalls).toHaveLength(0); expect(fallback.doGenerateCalls).toHaveLength(0);
  }));
  it('PNG累计bytes与文字累计chars限额反映到最终呈现元数据，图片不截成损坏文件', async () => fixture(async (store, _artifacts, image) => {
    const dom = await store.saveDom([{ tag: 'p', text: '长正文'.repeat(200) }], meta);
    const presenter = createEvidencePresenter(store, { capabilities: { 'mock:a': { images: true } } });
    const prepared = await prepareContext([], { ref: 'mock:a', signal: signal(), presenter, requiredEvidenceIds: [image.id, dom.id], maxAttachmentBytes: png.length - 1, maxAttachmentChars: 150 });
    expect(prepared.incompleteEvidenceIds).toEqual([image.id, dom.id]);
    expect(prepared.presentedEvidence).toEqual([{ id: dom.id, type: 'dom', truncated: true }]);
    expect(prepared.messages.flatMap(m => m.role === 'user' && Array.isArray(m.content) ? m.content : []).some(p => p.type === 'image')).toBe(false);
    const two = await prepareContext([], { ref: 'mock:a', signal: signal(), presenter: async () => [
      { id: 'one', type: 'screenshot', bytes: png, mediaType: 'image/png', truncated: false },
      { id: 'two', type: 'screenshot', bytes: png, mediaType: 'image/png', truncated: false },
    ], requiredEvidenceIds: ['one', 'two'], maxAttachmentBytes: png.length });
    expect(two.presentedEvidence).toEqual([{ id: 'one', type: 'screenshot', truncated: false }]);
    expect(two.incompleteEvidenceIds).toEqual(['two']);
  }));
  it.each(['pass', 'fail'] as const)('%s不能引用未呈现截图、错误类型或缺失DOM，完整截图+DOM可判', async verdict => fixture(async (store, _artifacts, image) => {
    const dom = await store.saveDom([{ tag: 'section', children: [{ tag: 'canvas', omitted: true }] }], meta);
    const value = { judgements: [{ expectationId: 'E1', verdict, evidenceIds: [image.id, dom.id], reasoning: '观察' }] };
    const texts = await createEvidencePresenter(store, { capabilities: { 'mock:a': { images: true } } })([image.id, dom.id], { ref: 'mock:a', signal: signal() });
    const shown = new Map(texts.map(e => [e.id, e]));
    expect((await validateJudgements(value, expectations, [image, dom], store, shown)).ok).toBe(false);
    const completeDom = await store.saveDom([{ tag: 'p', text: '完整DOM' }], meta);
    const complete = await prepareContext([], { presenter: createEvidencePresenter(store, { capabilities: { 'mock:a': { images: true } } }), ref: 'mock:a', signal: signal(), requiredEvidenceIds: [image.id, completeDom.id] });
    const good = { judgements: [{ ...value.judgements[0]!, evidenceIds: [image.id, completeDom.id] }] };
    const actual = new Map(complete.presentedEvidence.map(e => [e.id, e]));
    expect((await validateJudgements(good, expectations, [image, completeDom], store, actual)).ok).toBe(true);
    actual.delete(image.id);
    expect((await validateJudgements(good, expectations, [image, completeDom], store, actual)).ok).toBe(false);
    actual.set(image.id, { id: image.id, type: 'dom', truncated: false });
    expect((await validateJudgements(good, expectations, [image, completeDom], store, actual)).ok).toBe(false);
  }));
  it('DOM源省略在短正文中仍进入实际SDK缺失门禁，完整DOM保留全文和定位信息', async () => fixture(async store => {
    const dom = await store.saveDom([{ tag: 'p', text: '可见全文', locator: { strategy: 'css', value: '#message' } }, { tag: 'canvas', omitted: true }], meta);
    const model = scriptedModel([finish, finish, finish]);
    const events: EvidencePresentation[] = [];
    const result = await runAgent({ stage: 'review', models: [{ ref: 'mock:a', model }], system: '原文', messages: [], tools: [], output: z.object({ answer: z.string() }), budget: budget(), requiredEvidenceIds: [dom.id], evidencePresenter: createEvidencePresenter(store),
      onEvidencePresented: async event => { events.push(...event.evidence); },
    });
    expect(result).toMatchObject({ status: 'blocked', reason: 'invalid-output' });
    expect(events).toHaveLength(3); expect(events.every(e => e.type === 'dom' && e.truncated)).toBe(true);
    for (const call of model.doGenerateCalls) { expect(JSON.stringify(call.prompt)).toContain('可见全文'); expect(JSON.stringify(call.prompt)).toContain('#message'); expect(JSON.stringify(call.prompt)).toContain('宿主证据不完整'); }
  }));
  it('截图签名错误即使哈希匹配仍为宿主失败，不降为无图缺失', async () => fixture(async (store, artifacts, image) => {
    const bytes = Buffer.from('not a png');
    await artifacts.writeBytes(image.path, bytes);
    await artifacts.writeJson(`${prefix}/evidence/index.json`, [{ ...image, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }]);
    await expect(createEvidencePresenter(store)([image.id], { ref: 'mock:text', signal: signal() })).rejects.toThrow(/格式/);
  }));
  it('review-input仅白名单条款/预期/ID，executor哨兵不可进入主/备真实prompt', async () => fixture(async (store, _artifacts, image) => {
    const dirtyClause = { ...clauses[0]!, messages: 'EXECUTOR_MESSAGES_SENTINEL', reasoning: 'EXECUTOR_REASONING_SENTINEL' };
    const dirtyExpectation = { ...expectations[0]!, conclusion: 'EXECUTOR_CONCLUSION_SENTINEL', audit: 'EXECUTOR_AUDIT_SENTINEL' };
    const primary = scriptedModel([{ error: new Error('down') }]), backup = scriptedModel([finish]);
    const result = await runAgent({ stage: 'review', models: [{ ref: 'mock:a', model: primary }, { ref: 'mock:b', model: backup }], system: '独立', messages: buildReviewInput([dirtyClause], [dirtyExpectation], [image.id]), tools: [], output: z.object({ answer: z.string() }), budget: budget(), resilience: { retries: 0 }, evidencePresenter: createEvidencePresenter(store, { capabilities: { 'mock:a': { images: true }, 'mock:b': { images: true } } }), requiredEvidenceIds: [image.id] });
    expect(result.status).toBe('done');
    for (const call of [...primary.doGenerateCalls, ...backup.doGenerateCalls]) { expect(JSON.stringify(call.prompt)).not.toMatch(/EXECUTOR_.*SENTINEL/); expect(JSON.stringify(call.prompt)).toContain(image.id); }
  }));
});
