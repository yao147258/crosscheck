import { BudgetTracker } from '@crosscheck/core';
import { describe, expect, it, vi } from 'vitest';
import { createModelSummarizer, type ModelAttempt } from '../src/index';
import { scriptedModel } from '../src/testing/scripted-model';

const ctx = (steps: Parameters<typeof scriptedModel>[0]) => ({ candidate: { ref: 'mock:a', model: scriptedModel(steps) }, signal: new AbortController().signal, maxChars: 10_000 });
const valid = JSON.stringify({ goal: '登录', done: ['打开首页'], findings: ['有登录按钮'], evidenceIds: ['e1'], pending: [] });

describe('createModelSummarizer', () => {
  it('返回结构化摘要并计入预算与审计', async () => {
    const budget = new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 10 });
    const attempts: ModelAttempt[] = [];
    const summarize = createModelSummarizer({ budget, onAttempt: a => { attempts.push(a); } });
    const out = await summarize([{ role: 'user', content: '旧消息' }], ctx([{ text: '```json\n' + valid + '\n```' }]));
    expect(JSON.parse(out!)).toMatchObject({ goal: '登录', evidenceIds: ['e1'] });
    expect(budget.snapshot().tokens).toBe(15);
    expect(attempts).toEqual([{ ref: 'mock:a', status: 'success', usage: { inputTokens: 10, outputTokens: 5 }, purpose: 'compact' }]);
  });

  it('输出不合格或调用失败时返回 undefined，不重试', async () => {
    const budget = new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 10 });
    const onAttempt = vi.fn();
    const summarize = createModelSummarizer({ budget, onAttempt });
    expect(await summarize([], ctx([{ text: '不是 JSON' }]))).toBeUndefined();
    expect(await summarize([], ctx([{ error: new Error('超载') }]))).toBeUndefined();
    expect(onAttempt).toHaveBeenLastCalledWith({ ref: 'mock:a', status: 'error', usage: null, purpose: 'compact' });
  });

  it('宿主审计异常原样传播', async () => {
    const error = new Error('磁盘满');
    const summarize = createModelSummarizer({ budget: new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 10 }), onAttempt: () => { throw error; } });
    await expect(summarize([], ctx([{ text: valid }]))).rejects.toBe(error);
  });
});
