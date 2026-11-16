import { BudgetTracker } from '@crosscheck/core';
import { MockLanguageModelV4 } from 'ai/test';
import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runAgent, type RunAgentOptions } from '../src/index';
import { scriptedModel, type ScriptStep } from '../src/testing/scripted-model';

const base = z.object({ answer: z.string() });
function options(steps: ScriptStep[], extra: Partial<RunAgentOptions<z.infer<typeof base>>> = {}): RunAgentOptions<z.infer<typeof base>> {
  return { stage: 'execute', models: [{ ref: 'mock:a', model: scriptedModel(steps) }], system: '仅条款', messages: [{ role: 'user', content: '条款原文与预期' }], tools: [], output: base,
    budget: new BudgetTracker({ steps: 20, tokens: 100000, minutes: 10 }), resilience: { retries: 0 }, ...extra };
}
const finish = { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] };
function paired(messages: ModelMessage[]) {
  const calls = messages.flatMap(m => m.role === 'assistant' && Array.isArray(m.content) ? m.content.filter(p => p.type === 'tool-call').map(p => p.toolCallId) : []);
  const results = messages.flatMap(m => m.role === 'tool' ? m.content.filter(p => p.type === 'tool-result').map(p => p.toolCallId) : []);
  expect(calls.length).toBeGreaterThan(0);
  expect(results.sort()).toEqual(calls.sort());
}
describe('Task8 循环边界', () => {
  it.each(['bad.name', 'duplicate', 'finish'])('工具 %s 在调用模型和执行工具前拒绝', async name => {
    const execute = vi.fn(async () => 1);
    const t = { name, category: 'profile' as const, description: '', input: z.object({}), execute };
    const model = scriptedModel([finish]);
    await expect(runAgent(options([], { models: [{ ref: 'mock:a', model }], tools: name === 'duplicate' ? [t, t] : [t] }))).rejects.toThrow(/工具/);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });
  it('同轮三个 finish 只计一次 invalid', async () => {
    const r = await runAgent(options([{ toolCalls: Array.from({ length: 3 }, () => finish.toolCalls[0]!) }, finish]));
    expect(r).toMatchObject({ status: 'done', steps: 2 });
    paired(r.messages);
  });
  it('结构与异步语义错误共享三次额度，SDK 使用独立基础 schema', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { answer: 1 } }] }, finish, finish, finish]);
    const runtime = base.superRefine(async (_value, ctx) => { ctx.addIssue({ code: 'custom', message: '运行时语义' }); });
    const r = await runAgent(options([], { models: [{ ref: 'mock:a', model }], output: runtime, outputSchema: base,
      validateOutput: async () => ({ ok: false, error: '宿主语义' }) }));
    expect(r).toMatchObject({ status: 'blocked', reason: 'invalid-output', steps: 3 });
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(JSON.stringify(model.doGenerateCalls[0]?.tools)).not.toContain('运行时语义');
  });
  it('validateOutput 的异步拒绝与结构错误累计，不开启新循环', async () => {
    const validate = vi.fn(async () => ({ ok: false as const, error: '没有真实证据' }));
    const r = await runAgent(options([{ toolCalls: [{ name: 'finish', input: {} }] }, finish, finish, finish], { validateOutput: validate }));
    expect(r).toMatchObject({ status: 'blocked', reason: 'invalid-output', steps: 3 });
    expect(validate).toHaveBeenCalledTimes(2);
  });
  it('非法 JSON 作为工具错误反馈到下一次真实 provider 输入', async () => {
    let count = 0;
    const scripted = scriptedModel([finish]);
    const model = new MockLanguageModelV4({ doGenerate: async opts => {
      if (count++ > 0) return scripted.doGenerate(opts);
      return { content: [{ type: 'tool-call', toolCallId: 'bad-json', toolName: 'finish', input: '{broken' }], finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } }, warnings: [] };
    } });
    const r = await runAgent(options([], { models: [{ ref: 'mock:a', model }] }));
    expect(r.status).toBe('done');
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toMatch(/JSON|输入不合法/);
    paired(r.messages);
  });
  it.each(['abort', 'budget'] as const)('工具返回后立即检查 %s 并补齐整轮结果', async kind => {
    let now = 0;
    const ac = new AbortController();
    const second = vi.fn(async () => '不应执行');
    const tools = [
      { name: 'first', category: 'profile' as const, description: '', input: z.object({}), execute: async (_: unknown, ctx: { signal: AbortSignal }) => { expect(ctx.signal).toBeInstanceOf(AbortSignal); if (kind === 'abort') ac.abort(); else now = 60001; return '真实返回'; } },
      { name: 'second', category: 'profile' as const, description: '', input: z.object({}), execute: second },
    ];
    const r = await runAgent(options([{ toolCalls: [{ name: 'first', input: {} }, { name: 'second', input: {} }] }], { tools, signal: ac.signal, budget: new BudgetTracker({ steps: 20, tokens: 1000, minutes: 1 }, () => now) }));
    expect(r).toMatchObject({ status: 'blocked', reason: kind === 'abort' ? 'interrupted' : 'budget' });
    expect(second).not.toHaveBeenCalled();
    paired(r.messages);
  });
  it('模型结果超额时已附加的 assistant 调用也补齐结果', async () => {
    const r = await runAgent(options([finish], { budget: new BudgetTracker({ steps: 20, tokens: 1, minutes: 10 }) }));
    expect(r).toMatchObject({ status: 'blocked', reason: 'budget' });
    paired(r.messages);
  });
  it.each(['onUsage', 'onToolCall'] as const)('%s 异步持久化失败不允许 PASS', async callback => {
    await expect(runAgent(options([finish], { [callback]: async () => { await Promise.resolve(); throw new Error('持久化失败'); } }))).rejects.toThrow('持久化失败');
  });
  it('等待 usage 与工具回调完成才返回', async () => {
    const events: string[] = [];
    const r = await runAgent(options([finish], { onUsage: async () => { await Promise.resolve(); events.push('usage'); }, onToolCall: async () => { await Promise.resolve(); events.push('tool'); } }));
    expect(r.status).toBe('done');
    expect(events).toEqual(['usage', 'tool']);
  });
  it('语义失败不会因结构校验成功重置额度，且 maxInvalidOutputs 不能放宽到三次以上', async () => {
    const validateOutput = vi.fn(async () => ({ ok: false as const, error: '没有依据' }));
    const model = scriptedModel([finish, { toolCalls: [{ name: 'finish', input: { answer: 1 } }] }, finish, finish]);
    const r = await runAgent(options([], { models: [{ ref: 'mock:a', model }], validateOutput, maxInvalidOutputs: 99 }));
    expect(r).toMatchObject({ status: 'blocked', reason: 'invalid-output', steps: 3 });
    expect(validateOutput).toHaveBeenCalledTimes(2);
    expect(model.doGenerateCalls).toHaveLength(3);
  });
  it('失败重试和备用切换的全部时间纳入预算，超时后不调用备用', async () => {
    let now = 0;
    const budget = new BudgetTracker({ steps: 10, tokens: 1000, minutes: 1 }, () => now);
    const primary = new MockLanguageModelV4({ doGenerate: async () => { now = 60001; throw new Error('down'); } });
    const backup = scriptedModel([finish]);
    const r = await runAgent(options([], { models: [{ ref: 'mock:a', model: primary }, { ref: 'mock:b', model: backup }], budget }));
    expect(r).toMatchObject({ status: 'blocked', reason: 'budget', attempts: 1, steps: 0 });
    expect(backup.doGenerateCalls).toHaveLength(0);
    expect(budget.snapshot().elapsedMs).toBe(60001);
  });
  it.each(['success', 'error'] as const)('模型审计异步回调%s失败直接传播且不重试或虚构额外候选', async status => {
    const primary = scriptedModel(status === 'success' ? [finish] : [{ error: new Error('provider失败') }]);
    const fallback = scriptedModel([finish]); const seen: unknown[] = [];
    await expect(runAgent(options([], { models: [{ ref: 'mock:a', model: primary }, { ref: 'mock:b', model: fallback }], onModelAttempt: async attempt => { await Promise.resolve(); seen.push(attempt); throw new Error('宿主审计失败'); } }))).rejects.toThrow('宿主审计失败');
    expect(primary.doGenerateCalls).toHaveLength(1); expect(fallback.doGenerateCalls).toHaveLength(0); expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ ref: 'mock:a', status });
  });
  it.each([
    ['success', 'cancel'], ['error', 'cancel'], ['success', 'budget'], ['error', 'budget'],
  ] as const)('fix2审计回调%s与%s同时发生，宿主原错误优先', async (status, interruption) => {
    const primary = scriptedModel(status === 'success' ? [finish] : [{ error: new Error('provider失败') }]);
    const fallback = scriptedModel([finish]); const ac = new AbortController(); const events: unknown[] = []; let now = 0;
    const original = new Error('宿主模型审计磁盘失败');
    await expect(runAgent(options([], {
      models: [{ ref: 'mock:a', model: primary }, { ref: 'mock:b', model: fallback }],
      resilience: { retries: 1, sleep: async () => {} }, signal: ac.signal,
      budget: new BudgetTracker({ steps: 10, tokens: 1000, minutes: 1 }, () => now),
      onModelAttempt: async attempt => {
        events.push(attempt); await Promise.resolve();
        if (interruption === 'cancel') ac.abort(); else now = 60001;
        throw original;
      },
    }))).rejects.toBe(original);
    expect(primary.doGenerateCalls).toHaveLength(1); expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ ref: 'mock:a', status });
  });
  it.each(['cancel', 'budget'] as const)('fix2 presenter宿主错误与%s同时发生仍保留原对象且零provider调用', async interruption => {
    const primary = scriptedModel([finish]); const fallback = scriptedModel([finish]); const ac = new AbortController(); let now = 0, presentations = 0;
    const original = new Error('宿主证据读取磁盘失败'); const events: unknown[] = [];
    await expect(runAgent(options([], {
      models: [{ ref: 'mock:a', model: primary }, { ref: 'mock:b', model: fallback }], signal: ac.signal,
      budget: new BudgetTracker({ steps: 10, tokens: 1000, minutes: 1 }, () => now), requiredEvidenceIds: ['e-real'],
      evidencePresenter: async () => { presentations++; await Promise.resolve(); if (interruption === 'cancel') ac.abort(); else now = 60001; throw original; },
      onModelAttempt: async attempt => { events.push(attempt); },
    }))).rejects.toBe(original);
    expect(presentations).toBe(1); expect(primary.doGenerateCalls).toHaveLength(0); expect(fallback.doGenerateCalls).toHaveLength(0); expect(events).toEqual([]);
  });
  it.each(['cancel', 'deadline'] as const)('最终修复 I5 presenter正常%s不能被标记宿主失败且零provider调用', async kind => {
    const primary = scriptedModel([finish]); const fallback = scriptedModel([finish]); const ac = new AbortController();
    const result = await runAgent(options([], {
      models: [{ ref: 'mock:a', model: primary }, { ref: 'mock:b', model: fallback }], signal: ac.signal,
      budget: new BudgetTracker({ steps: 10, tokens: 1000, minutes: kind === 'deadline' ? 0.001 : 1 }), requiredEvidenceIds: ['e-real'],
      evidencePresenter: async (_ids, context) => {
        if (kind === 'cancel') ac.abort();
        else await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        context.signal.throwIfAborted(); return [];
      },
    }));
    expect(result).toMatchObject({ status: 'blocked', reason: kind === 'cancel' ? 'interrupted' : 'budget', attempts: 0 });
    expect(primary.doGenerateCalls).toHaveLength(0); expect(fallback.doGenerateCalls).toHaveLength(0);
  });
  it('全部厂商失败也保留每次真实候选审计与未知 usage', async () => {
    const r = await runAgent(options([{ error: new Error('down') }, { error: new Error('down') }], { resilience: { retries: 1, sleep: async () => {} } }));
    expect(r).toMatchObject({ status: 'blocked', reason: 'model-error', attempts: 2, steps: 0, retried: true });
    expect(r.modelAttempts).toEqual([{ ref: 'mock:a', status: 'error', usage: null }, { ref: 'mock:a', status: 'error', usage: null }]);
  });
  it('失败 attempts 独立于轮次，失败用量不伪造', async () => {
    const primary = scriptedModel([{ error: new Error('down') }]);
    const backup = scriptedModel([finish]);
    const usage = vi.fn();
    const r = await runAgent(options([], { models: [{ ref: 'mock:a', model: primary }, { ref: 'mock:b', model: backup }], onUsage: usage }));
    expect(r).toMatchObject({ status: 'done', steps: 1, attempts: 2 });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith('mock:b', { inputTokens: 10, outputTokens: 5 });
    expect(r.modelAttempts).toEqual([
      { ref: 'mock:a', status: 'error', usage: null },
      { ref: 'mock:b', status: 'success', usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });
});
