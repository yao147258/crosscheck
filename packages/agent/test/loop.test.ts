import { BudgetTracker } from '@crosscheck/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, runAgent, type RunAgentOptions } from '../src/index';
import { scriptedModel, type ScriptStep } from '../src/testing/scripted-model';

const Output = z.object({ answer: z.string() });

const echo = defineTool({
  name: 'echo',
  category: 'profile',
  description: '原样返回',
  input: z.object({ x: z.number() }),
  execute: vi.fn(async (input: { x: number }) => ({ echoed: input.x })),
});

const fixture = defineTool({
  name: 'fixture_apply',
  category: 'fixture',
  description: '造数',
  input: z.object({ name: z.string() }),
  execute: vi.fn(async () => 'done'),
});

function opts(steps: ScriptStep[], over: Partial<RunAgentOptions<z.infer<typeof Output>>> = {}) {
  const model = scriptedModel(steps);
  return {
    model,
    options: {
      stage: 'execute',
      models: [{ ref: 'mock:primary', model }],
      system: '你是测试员',
      messages: [{ role: 'user', content: '开始' }],
      tools: [echo, fixture],
      output: Output,
      budget: new BudgetTracker({ steps: 10, tokens: 1_000_000, minutes: 10 }),
      resilience: { retries: 0, sleep: async () => {} },
      ...over,
    } satisfies RunAgentOptions<z.infer<typeof Output>>,
  };
}

const promptText = (model: ReturnType<typeof scriptedModel>, i: number) => JSON.stringify(model.doGenerateCalls[i]?.prompt);

describe('runAgent', () => {
  it('调用工具后提交合法结果', async () => {
    const events: unknown[] = [];
    const { model, options } = opts([
      { toolCalls: [{ name: 'echo', input: { x: 7 } }] },
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
    ]);
    const r = await runAgent({ ...options, onToolCall: (e) => events.push(e) });
    expect(r).toMatchObject({ status: 'done', output: { answer: 'ok' }, steps: 2, retried: false });
    expect(events[0]).toEqual({ name: 'echo', input: { x: 7 }, ok: true, output: { echoed: 7 } });
    expect(promptText(model, 1)).toContain('echoed');
  });

  it('执行阶段调用夹具工具会被拒绝，夹具不会执行', async () => {
    const { model, options } = opts([
      { toolCalls: [{ name: 'fixture_apply', input: { name: 'reset' } }] },
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
    ]);
    const r = await runAgent(options);
    expect(r.status).toBe('done');
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(promptText(model, 1)).toContain('未授予');
  });

  it('工具输入不合 schema 时把错误反馈给模型', async () => {
    const { model, options } = opts([
      { toolCalls: [{ name: 'echo', input: { x: 'NaN' } }] },
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
    ]);
    await runAgent(options);
    expect(promptText(model, 1)).toContain('输入不合法');
  });

  it('工具抛错时把错误反馈给模型', async () => {
    const boom = defineTool({
      name: 'boom',
      category: 'browser',
      description: '总是失败',
      input: z.object({}),
      execute: async () => {
        throw new Error('页面崩溃');
      },
    });
    const { model, options } = opts(
      [{ toolCalls: [{ name: 'boom', input: {} }] }, { toolCalls: [{ name: 'finish', input: { answer: 'x' } }] }],
      { tools: [boom] },
    );
    await runAgent(options);
    expect(promptText(model, 1)).toContain('页面崩溃');
  });

  it('结果连续 3 次不合格判为 BLOCKED', async () => {
    const bad = { toolCalls: [{ name: 'finish', input: { answer: 1 } }] };
    const { options } = opts([bad, bad, bad, { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    const r = await runAgent(options);
    expect(r).toMatchObject({ status: 'blocked', reason: 'invalid-output' });
  });

  it('只回复文本不调用工具也计为不合格，并提醒模型', async () => {
    const { model, options } = opts([{ text: '我做完了' }, { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    const r = await runAgent(options);
    expect(r.status).toBe('done');
    expect(promptText(model, 1)).toContain('必须调用工具');
  });

  it('代理上报障碍', async () => {
    const { options } = opts([{ toolCalls: [{ name: 'report_blocked', input: { reason: '登录页 500' } }] }]);
    expect(await runAgent(options)).toMatchObject({ status: 'blocked', reason: 'reported', detail: '登录页 500' });
  });

  it('步数预算耗尽', async () => {
    const loop = { toolCalls: [{ name: 'echo', input: { x: 1 } }] };
    const { options } = opts([loop, loop, loop], {
      budget: new BudgetTracker({ steps: 2, tokens: 1_000_000, minutes: 10 }),
    });
    const r = await runAgent(options);
    expect(r).toMatchObject({ status: 'blocked', reason: 'budget', steps: 2 });
  });

  it('已中断时不调用模型', async () => {
    const ac = new AbortController();
    ac.abort();
    const { model, options } = opts([], { signal: ac.signal });
    expect(await runAgent(options)).toMatchObject({ status: 'blocked', reason: 'interrupted' });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('主模型失败时切换备用模型，并标记为发生过重试', async () => {
    const primary = scriptedModel([{ error: new Error('503') }, { error: new Error('503') }]);
    const backup = scriptedModel([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    const { options } = opts([], {
      models: [
        { ref: 'mock:primary', model: primary },
        { ref: 'mock:backup', model: backup },
      ],
      resilience: { retries: 1, sleep: async () => {} },
    });
    const r = await runAgent(options);
    expect(r).toMatchObject({ status: 'done', retried: true });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it('所有模型都失败时判为 model-error', async () => {
    const { options } = opts([{ error: new Error('401') }]);
    expect(await runAgent(options)).toMatchObject({ status: 'blocked', reason: 'model-error' });
  });

  it('上报每次调用的 token 用量', async () => {
    const onUsage = vi.fn();
    const { options } = opts([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }], { onUsage });
    await runAgent(options);
    expect(onUsage).toHaveBeenCalledWith('mock:primary', expect.objectContaining({ inputTokens: 10, outputTokens: 5 }));
  });

  it('自定义工具不能与内置工具重名', async () => {
    const clash = defineTool({ name: 'finish', category: 'profile', description: '', input: z.object({}), execute: async () => 1 });
    const { options } = opts([], { tools: [clash] });
    await expect(runAgent(options)).rejects.toThrow(/内置工具/);
  });
});
