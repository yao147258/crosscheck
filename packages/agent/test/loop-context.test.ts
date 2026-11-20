import { BudgetTracker } from '@crosscheck/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContextManager, defineTool, runAgent, type ContextPreparedEvent, type ModelAttempt, type RunAgentOptions } from '../src/index';
import { scriptedModel, type ScriptStep } from '../src/testing/scripted-model';

const Output = z.object({ answer: z.string() });
const echo = defineTool({ name: 'echo', category: 'profile', description: '原样返回', input: z.object({ x: z.number() }), execute: async (i: { x: number }) => ({ echoed: i.x }) });
const finish = { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] };
const ephemeral = { anthropic: { cacheControl: { type: 'ephemeral' } } };

function setup(steps: ScriptStep[], over: Partial<RunAgentOptions<z.infer<typeof Output>>> = {}, providerType?: 'anthropic' | 'openai') {
  const model = scriptedModel(steps);
  const options: RunAgentOptions<z.infer<typeof Output>> = {
    stage: 'execute', models: [{ ref: 'mock:a', model, ...(providerType ? { providerType } : {}) }], system: '你是测试员',
    messages: [{ role: 'user', content: '开始' }], tools: [echo], output: Output,
    budget: new BudgetTracker({ steps: 10, tokens: 1_000_000, minutes: 10 }), resilience: { retries: 0, sleep: async () => {} }, ...over,
  };
  return { model, options };
}
const cached = (prompt: unknown[]) => prompt.filter(m => (m as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }).providerOptions?.anthropic?.cacheControl);

describe('循环上下文管理', () => {
  it('Anthropic 候选在 system 与历史最后一条设置缓存断点', async () => {
    const { model, options } = setup([{ toolCalls: [{ name: 'echo', input: { x: 1 } }] }, finish], {}, 'anthropic');
    await runAgent(options);
    const prompt = model.doGenerateCalls[1]!.prompt as unknown[];
    expect(prompt[0]).toMatchObject({ role: 'system', providerOptions: ephemeral });
    expect(cached(prompt)).toHaveLength(2);
    expect(prompt.at(-1)).toMatchObject({ role: 'tool', providerOptions: ephemeral });
  });

  it('OpenAI 与未知 provider 不设置断点', async () => {
    for (const type of ['openai', undefined] as const) {
      const { model, options } = setup([finish], {}, type);
      await runAgent(options);
      expect(cached(model.doGenerateCalls[0]!.prompt as unknown[])).toHaveLength(0);
    }
  });

  it('缓存用量仅在返回时出现在 ModelAttempt 中', async () => {
    const { options } = setup([{ ...finish, usage: { input: 100, cacheRead: 60, cacheWrite: 10 } }]);
    const r = await runAgent(options);
    expect(r.modelAttempts).toEqual([{ ref: 'mock:a', status: 'success', usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 10 } }]);
  });

  it('上报上下文报告并以真实 usage 校准', async () => {
    const events: ContextPreparedEvent[] = [];
    const { options } = setup([{ toolCalls: [{ name: 'echo', input: { x: 1 } }], usage: { input: 10_000 } }, finish], { onContextPrepared: e => { events.push(e); } });
    await runAgent(options);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ ref: 'mock:a', factor: 1, compacted: false });
    expect(events[1]!.factor).toBeGreaterThan(1);
  });

  it('宿主提供 agentId 时事件带标签，未提供时结构不变', async () => {
    const attempts: ModelAttempt[] = [];
    const tagged = setup([finish], { agentId: 'root', onModelAttempt: a => { attempts.push(a); } });
    await runAgent(tagged.options);
    expect(attempts[0]).toMatchObject({ agentId: 'root' });
    const plain = await runAgent(setup([finish]).options);
    expect(plain.modelAttempts[0]).not.toHaveProperty('agentId');
  });

  it('上下文报告回调异常按宿主故障原样传播', async () => {
    const error = new Error('写盘失败');
    const { options } = setup([finish], { onContextPrepared: () => { throw error; } });
    await expect(runAgent(options)).rejects.toBe(error);
  });

  it('摘要调用被中止时 provider 抛普通错误，仍按预算/中断阻塞而非宿主故障', async () => {
    // 40K 窗口下长 assistant 文本经 L1/L2 仍超水位，plan 阶段触发模型摘要；首个模型调用即摘要调用。
    const messages = [
      { role: 'user' as const, content: '开始' },
      ...Array.from({ length: 4 }, () => ({ role: 'assistant' as const, content: 'y'.repeat(30_000) })),
      { role: 'user' as const, content: '继续' },
    ];
    const over = (extra: Partial<RunAgentOptions<z.infer<typeof Output>>>) => ({ stage: 'plan' as const, messages, ...extra });
    const withWindow = (o: RunAgentOptions<z.infer<typeof Output>>) => ({ ...o, models: o.models.map(m => ({ ...m, contextWindow: 40_000 })) });

    const timed = setup([{ hangWithGenericError: true }], over({ budget: new BudgetTracker({ steps: 10, tokens: 1_000_000, minutes: 0.005 }) }));
    const r1 = await runAgent(withWindow(timed.options));
    expect(r1).toMatchObject({ status: 'blocked', reason: 'budget' });
    expect(timed.model.doGenerateCalls).toHaveLength(1);

    const controller = new AbortController();
    const interrupted = setup([{ hangWithGenericError: true }], over({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const r2 = await runAgent(withWindow(interrupted.options));
    expect(r2).toMatchObject({ status: 'blocked', reason: 'interrupted' });
  });

  it('可注入自定义 ContextManager', async () => {
    const manager = new ContextManager({ stage: 'execute' });
    const { options } = setup([finish], { contextManager: manager });
    await runAgent(options);
    expect(manager.report()).toMatchObject({ ref: 'mock:a' });
  });
});
