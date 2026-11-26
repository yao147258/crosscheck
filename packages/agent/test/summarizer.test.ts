import { BudgetTracker } from '@crosscheck/core';
import type { UsageAttempt } from '@crosscheck/models';
import { describe, expect, it, vi } from 'vitest';
import { createModelSummarizer, type ModelAttempt } from '../src/index';
import { scriptedModel } from '../src/testing/scripted-model';

const ctx = (steps: Parameters<typeof scriptedModel>[0]) => ({ candidate: { ref: 'mock:a', model: scriptedModel(steps) }, signal: new AbortController().signal, maxChars: 10_000 });
const valid = JSON.stringify({ goal: '登录', done: ['打开首页'], findings: ['有登录按钮'], evidenceIds: ['e1'], pending: [] });

describe('createModelSummarizer', () => {
  it('返回结构化摘要并计入预算与审计', async () => {
    const budget = new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 10 });
    const attempts: ModelAttempt[] = [];
    const usage: UsageAttempt[] = [];
    const summarize = createModelSummarizer({ budget, onAttempt: a => { attempts.push(a); }, usageObserver: a => { usage.push(a); throw new Error('账本不可用'); } });
    const out = await summarize([{ role: 'user', content: '旧消息' }], ctx([{ text: '```json\n' + valid + '\n```', usage: { cacheRead: 6, cacheWrite: 0 } }]));
    expect(usage).toEqual([{ ref: 'mock:a', status: 'success', purpose: 'compact', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 6, cacheWriteTokens: 0 } }]);
    expect(JSON.parse(out!)).toMatchObject({ goal: '登录', evidenceIds: ['e1'] });
    expect(budget.snapshot().tokens).toBe(15);
    expect(attempts).toEqual([{ ref: 'mock:a', status: 'success', usage: { inputTokens: 10, outputTokens: 5 }, purpose: 'compact' }]);
  });

  it('输出不合格或调用失败时返回 undefined，不重试', async () => {
    const budget = new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 10 });
    const onAttempt = vi.fn();
    const usage: UsageAttempt[] = [];
    const summarize = createModelSummarizer({ budget, onAttempt, usageObserver: attempt => { usage.push(attempt); } });
    expect(await summarize([], ctx([{ text: '不是 JSON' }]))).toBeUndefined();
    expect(await summarize([], ctx([{ error: new Error('超载') }]))).toBeUndefined();
    expect(usage).toEqual([
      { ref: 'mock:a', status: 'success', purpose: 'compact', usage: { inputTokens: 10, outputTokens: 5 } },
      { ref: 'mock:a', status: 'error', purpose: 'compact', usage: null },
    ]);
    expect(onAttempt).toHaveBeenLastCalledWith({ ref: 'mock:a', status: 'error', usage: null, purpose: 'compact' });
  });

  it('摘要 SDK 在进入模型前抛错仍执行严格审计，但不入账', async () => {
    const error = new Error('审计写入失败');
    const onAttempt = vi.fn(() => { throw error; });
    const usageObserver = vi.fn();
    const summarize = createModelSummarizer({ budget: new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 10 }), onAttempt, usageObserver });
    const context = ctx([]);
    Object.defineProperty(context.candidate.model, 'supportedUrls', { get: () => Promise.reject(new Error('SDK 读取模型支持的 URL 失败')) });
    await expect(summarize([], context)).rejects.toBe(error);
    expect(onAttempt.mock.calls).toEqual([[{ ref: 'mock:a', status: 'error', usage: null, purpose: 'compact' }]]);
    expect(usageObserver).not.toHaveBeenCalled();
    expect(context.candidate.model.doGenerateCalls).toHaveLength(0);
  });

  it('摘要 SDK 后处理失败时账本保留原始回执，严格审计和预算不变', async () => {
    const budget = new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 10 });
    const onAttempt = vi.fn();
    const usageObserver = vi.fn();
    const summarize = createModelSummarizer({ budget, onAttempt, usageObserver });
    const context = ctx([{ text: valid, usage: { input: 19, output: 7, cacheRead: 0, cacheWrite: 2 } }]);
    const model = context.candidate.model;
    const generate = model.doGenerate.bind(model);
    vi.spyOn(model, 'doGenerate').mockImplementation(async options => ({
      ...await generate(options),
      get content(): never { throw new Error('SDK 后处理读取内容失败'); },
    }));
    await expect(summarize([], context)).resolves.toBeUndefined();
    expect(budget.snapshot().tokens).toBe(0);
    expect(onAttempt.mock.calls).toEqual([[{ ref: 'mock:a', status: 'error', usage: null, purpose: 'compact' }]]);
    expect(usageObserver.mock.calls).toEqual([[{ ref: 'mock:a', purpose: 'compact', status: 'error', usage: { inputTokens: 19, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 2 } }]]);
  });

  it.each([false, true])('仅在摘要请求已发出时记录取消（预取消：%s）', async (preCancelled) => {
    const controller = new AbortController();
    const reason = new Error('用户取消');
    const usage: UsageAttempt[] = [];
    const onAttempt = vi.fn();
    const budget = new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 10 });
    const summarize = createModelSummarizer({ budget, onAttempt, usageObserver: attempt => { usage.push(attempt); } });
    const context = ctx(preCancelled ? [{ text: valid }] : [{ hangWithGenericError: true }]);
    if (preCancelled) controller.abort(reason);
    else {
      // 等到脚本模型收到请求，再取消，避免把请求前中止误当作请求中止。
      const model = context.candidate.model;
      const generate = model.doGenerate.bind(model);
      model.doGenerate = options => {
        const pending = generate(options);
        controller.abort(reason);
        return pending;
      };
    }
    await expect(summarize([], { ...context, signal: controller.signal })).rejects.toBe(reason);
    expect(context.candidate.model.doGenerateCalls).toHaveLength(preCancelled ? 0 : 1);
    expect(usage).toEqual(preCancelled ? [] : [{ ref: 'mock:a', status: 'cancelled', purpose: 'compact', usage: null }]);
    expect(onAttempt).not.toHaveBeenCalled();
  });

  it('独立摘要先完成宿主审计，再排空慢观察者', async () => {
    const phases: string[] = [];
    const summarize = createModelSummarizer({
      budget: new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 10 }),
      onAttempt: () => { phases.push('审计'); },
      usageObserver: async () => { await Promise.resolve(); phases.push('用量'); },
    });
    await expect(summarize([], ctx([{ text: valid }]))).resolves.toBe(valid);
    expect(phases).toEqual(['审计', '用量']);
  });

  it('宿主审计异常原样传播', async () => {
    const error = new Error('磁盘满');
    const summarize = createModelSummarizer({ budget: new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 10 }), onAttempt: () => { throw error; } });
    await expect(summarize([], ctx([{ text: valid }]))).rejects.toBe(error);
  });
});
