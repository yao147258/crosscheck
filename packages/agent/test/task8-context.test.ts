import { BudgetTracker } from '@crosscheck/core';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compressContext, prepareContext, runAgent, type EvidencePresenter } from '../src/index';
import { scriptedModel } from '../src/testing/scripted-model';
const history: ModelMessage[] = [
  { role: 'system', content: '系统不丢' }, { role: 'user', content: '条款原文与预期不丢' },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'old', toolName: 'query', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'old', toolName: 'query', output: { type: 'json', value: { evidenceIds: ['e-old'], body: 'x'.repeat(10000) } } }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'new', toolName: 'query', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'new', toolName: 'query', output: { type: 'json', value: { evidenceIds: ['e-new'], body: 'y'.repeat(10000) } } }] },
];
const presenter: EvidencePresenter = async (ids) => ids.map(id => ({ id, type: 'db', text: `真实脱敏行 ${id}`, truncated: false }));

describe('Task8 确定性上下文', () => {
  it('真正附件总大小含截断标记不超过配置上限', async () => {
    const prepared = await prepareContext(history, { ref: 'mock:a', signal: new AbortController().signal,
      presenter: async ids => ids.map(id => ({ id, type: 'db' as const, text: 'x'.repeat(200), truncated: true })), maxAttachmentChars: 150 });
    const attachments = prepared.messages.slice(history.length).filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[宿主证据 '));
    expect(attachments.reduce((total, m) => total + (m.content as string).length, 0)).toBeLessThanOrEqual(150);
    expect(prepared.incompleteEvidenceIds).toEqual(['e-old', 'e-new']);
  });
  it('旧工具正文中的全部引用字段与超长输入 ID 都保留，最近调用不拆散', () => {
    const custom = structuredClone(history);
    if (custom[3]?.role === 'tool') custom[3].content = [{ type: 'tool-result', toolCallId: 'old', toolName: 'query', output: { type: 'json', value: { nested: { evidenceId: 'e-nested', evidenceIds: ['e-list'] }, text: 'x'.repeat(10000) } } }];
    const r = compressContext(custom, { maxToolChars: 50 });
    expect(r.evidenceIds).toEqual(['e-nested', 'e-list', 'e-new']);
    expect(JSON.stringify(r.messages)).toContain('e-nested');
    expect(JSON.stringify(r.messages)).toContain('e-list');
    expect(r.messages.slice(-2)).toEqual(custom.slice(-2));
  });
  it('presenter 持久化或核验错误向宿主传播，不调用主备 provider', async () => {
    const primary = scriptedModel([]), backup = scriptedModel([]);
    await expect(runAgent({ stage: 'review', system: '条款', messages: [{ role: 'user', content: '预期' }], tools: [], output: z.object({ answer: z.string() }),
      models: [{ ref: 'mock:a', model: primary }, { ref: 'mock:b', model: backup }], requiredEvidenceIds: ['e-real'], evidencePresenter: async () => { throw new Error('哈希错误'); },
      budget: new BudgetTracker({ steps: 10, tokens: 10000, minutes: 1 }), resilience: { retries: 0 } })).rejects.toThrow('哈希错误');
    expect(primary.doGenerateCalls).toHaveLength(0);
    expect(backup.doGenerateCalls).toHaveLength(0);
  });
  it('压缩大型旧工具正文，保留条款、最近完整调用对与全部 ID，输入不变', () => {
    const before = JSON.stringify(history);
    const first = compressContext(history, { maxToolChars: 500, retainRecentToolRounds: 1 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(compressContext(history, { maxToolChars: 500, retainRecentToolRounds: 1 })));
    expect(JSON.stringify(history)).toBe(before);
    expect(JSON.stringify(first.messages)).toContain('系统不丢');
    expect(JSON.stringify(first.messages)).toContain('条款原文与预期不丢');
    expect(first.messages.slice(-2)).toEqual(history.slice(-2));
    expect(first.evidenceIds).toEqual(['e-old', 'e-new']);
    expect(JSON.stringify(first.messages)).toContain('compressed');
    expect(JSON.stringify(first.messages)).not.toContain('x'.repeat(1000));
    expect(first.messages.map(m => m.role)).toEqual(history.map(m => m.role));
  });
  it('旧附件压缩有明确标记、全部 ID 保留且非附件 user 不变', () => {
    const messages: ModelMessage[] = [...history.slice(0, 4), { role: 'user', content: '[宿主证据 e-old]\n' + 'z'.repeat(10000) }, ...history.slice(4)];
    const r = compressContext(messages, { maxEvidenceChars: 200, retainRecentToolRounds: 1 });
    expect(JSON.stringify(r.messages)).not.toContain('z'.repeat(1000));
    expect(JSON.stringify(r.messages)).toContain('truncated');
    expect(r.messages[1]).toEqual(messages[1]);
    expect(r.evidenceIds).toContain('e-old');
  });
  it('总附件上限明确 truncated，必需证据每次重新呈现且报告完整性', async () => {
    const prepared = await prepareContext(history, { ref: 'mock:a', signal: new AbortController().signal, presenter,
      requiredEvidenceIds: ['e-old'], maxAttachmentChars: 20 });
    expect(prepared.evidenceIds).toEqual(['e-old', 'e-new']);
    expect(prepared.incompleteEvidenceIds).toContain('e-old');
    expect(JSON.stringify(prepared.messages)).toContain('truncated');
    const full = await prepareContext(history, { ref: 'mock:a', signal: new AbortController().signal, presenter, requiredEvidenceIds: ['e-old'] });
    expect(full.incompleteEvidenceIds).toEqual([]);
    expect(JSON.stringify(full.messages.slice(history.length))).toContain('真实脱敏行 e-old');
  });
  it('主备与重试真实 provider 输入都有中性证据，不混入工具审计结论', async () => {
    const primary = scriptedModel([{ error: new Error('down') }, { error: new Error('down') }]);
    const backup = scriptedModel([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    const refs: string[] = [];
    const r = await runAgent({ stage: 'review', system: '仅按条款', messages: [{ role: 'user', content: '条款原文/预期' }], tools: [], output: z.object({ answer: z.string() }),
      models: [{ ref: 'mock:primary', model: primary }, { ref: 'mock:backup', model: backup }], budget: new BudgetTracker({ steps: 10, tokens: 10000, minutes: 1 }),
      evidencePresenter: async (ids, ctx) => { refs.push(ctx.ref); return presenter(ids, ctx); }, requiredEvidenceIds: ['e-real'],
      resilience: { retries: 1, sleep: async () => {} } });
    expect(r.status).toBe('done');
    expect(refs).toEqual(['mock:primary', 'mock:primary', 'mock:backup']);
    for (const call of [...primary.doGenerateCalls, ...backup.doGenerateCalls]) {
      const input = JSON.stringify(call.prompt);
      expect(input).toContain('真实脱敏行 e-real');
      expect(input).not.toContain('EXECUTOR_CONCLUSION_SENTINEL');
      expect(input).not.toContain('执行成功');
    }
  });
  it('工具整轮结果完整后才在 provider 输入追加证据正文，不装配输出里的结论', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'query', input: {} }, { name: 'query', input: {} }] }, { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    const r = await runAgent({ stage: 'execute', system: '条款', messages: [{ role: 'user', content: '条款与预期' }], models: [{ ref: 'mock:a', model }], tools: [{ name: 'query', category: 'db', description: '', input: z.object({}), execute: async () => ({ evidenceIds: ['e-real'], conclusion: 'EXECUTOR_CONCLUSION_SENTINEL' }) }], output: z.object({ answer: z.string() }), evidencePresenter: presenter, budget: new BudgetTracker({ steps: 10, tokens: 10000, minutes: 1 }) });
    expect(r.status).toBe('done');
    const prompt = model.doGenerateCalls[1]!.prompt;
    const toolIndex = prompt.findIndex(m => m.role === 'tool');
    expect(prompt[toolIndex]).toMatchObject({ role: 'tool', content: expect.arrayContaining([expect.objectContaining({ type: 'tool-result' })]) });
    expect((prompt[toolIndex]!.content as unknown[]).length).toBe(2);
    const attachment = JSON.stringify(prompt.slice(toolIndex + 1));
    expect(attachment).toContain('真实脱敏行 e-real');
    expect(attachment).not.toContain('EXECUTOR_CONCLUSION_SENTINEL');
  });
  it('缺失或截断的必需证据不允许 finish，由累计三次额度停止', async () => {
    const model = scriptedModel(Array.from({ length: 3 }, () => ({ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] })));
    const r = await runAgent({ stage: 'review', system: '条款', messages: [{ role: 'user', content: '条款与预期' }], tools: [], models: [{ ref: 'mock:a', model }], output: z.object({ answer: z.string() }),
      requiredEvidenceIds: ['e-real'], evidencePresenter: async () => [{ id: 'e-real', type: 'db', text: '截断', truncated: true }], budget: new BudgetTracker({ steps: 10, tokens: 10000, minutes: 1 }) });
    expect(r).toMatchObject({ status: 'blocked', reason: 'invalid-output', steps: 3 });
  });
});
