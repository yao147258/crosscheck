import { BudgetTracker } from '@crosscheck/core';
import { withProgress } from '@crosscheck/models';
import type { ModelMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

/** 断言：每个助手发出的 toolCallId 在后续的 tool 消息里恰好出现一次，且不存在两条相邻的 tool 消息 */
function assertEachToolCallHasExactlyOneResult(messages: ModelMessage[]) {
  const callIds: string[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const part of m.content) if ((part as { type: string }).type === 'tool-call') callIds.push((part as { toolCallId: string }).toolCallId);
    }
  }
  for (const id of callIds) {
    let count = 0;
    for (const m of messages) {
      if (m.role === 'tool' && Array.isArray(m.content)) {
        count += m.content.filter((p) => (p as { toolCallId?: string }).toolCallId === id).length;
      }
    }
    expect(count).toBe(1);
  }
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i]?.role === 'tool') expect(messages[i + 1]?.role).not.toBe('tool');
  }
}

describe('runAgent', () => {
  beforeEach(() => {
    (echo.execute as ReturnType<typeof vi.fn>).mockClear();
    (fixture.execute as ReturnType<typeof vi.fn>).mockClear();
  });

  it('调用工具后提交合法结果', async () => {
    const events: unknown[] = [];
    const { model, options } = opts([
      { toolCalls: [{ name: 'echo', input: { x: 7 } }] },
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
    ]);
    const r = await runAgent({ ...options, onToolCall: (e) => { events.push(e); } });
    expect(r).toMatchObject({ status: 'done', output: { answer: 'ok' }, steps: 2, retried: false });
    expect(events[0]).toEqual({ name: 'echo', input: { x: 7 }, ok: true, output: { echoed: 7 } });
    expect(promptText(model, 1)).toContain('echoed');
  });

  it('在进度上下文中上报模型请求、工具调用与提交结果', async () => {
    const lines: string[] = [];
    const { options } = opts([
      { toolCalls: [{ name: 'echo', input: { x: 7 } }] },
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
    ]);
    await withProgress((line) => lines.push(line), () => runAgent(options));
    expect(lines).toEqual([
      '[执行] 第 1 轮：请求模型 mock:primary 思考下一步',
      '[执行] 调用工具 echo（x=7）：原样返回',
      '[执行] 第 2 轮：请求模型 mock:primary 思考下一步',
      '[执行] 提交最终结果',
    ]);
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

  it('结果累计 3 次不合格判为 BLOCKED', async () => {
    const bad = { toolCalls: [{ name: 'finish', input: { answer: 1 } }] };
    const { options } = opts([bad, bad, bad, { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    const r = await runAgent(options);
    expect(r).toMatchObject({ status: 'blocked', reason: 'invalid-output' });
  });

  it('按候选上下文窗口设置 maxOutputTokens', async () => {
    const ok = { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] };
    const { model, options } = opts([ok]);
    await runAgent(options);
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(128_000);
    const small = opts([ok]);
    await runAgent({ ...small.options, models: [{ ref: 'mock:small[32K]', model: small.model, contextWindow: 32_000 }] });
    const limit = small.model.doGenerateCalls[0]?.maxOutputTokens ?? 0;
    expect(limit).toBeGreaterThan(20_000);
    expect(limit).toBeLessThan(32_000);
  });

  it('输入超出上下文窗口时不发请求，判为模型错误', async () => {
    const { model, options } = opts([]);
    const r = await runAgent({ ...options, models: [{ ref: 'mock:tiny[1K]', model, contextWindow: 1_000 }], messages: [{ role: 'user', content: '中'.repeat(5_000) }] });
    expect(r).toMatchObject({ status: 'blocked', reason: 'model-error' });
    expect((r as { detail: string }).detail).toMatch(/上下文窗口/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('输出被截断时提醒模型，最终错误写明截断', async () => {
    const cut = { toolCalls: [{ name: 'finish', input: { answer: 1 } }], truncated: true };
    const { model, options } = opts([cut, cut, cut]);
    const r = await runAgent(options);
    expect(r).toMatchObject({ status: 'blocked', reason: 'invalid-output' });
    expect((r as { detail: string }).detail).toMatch(/截断/);
    expect(promptText(model, 1)).toContain('截断');
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

  describe('同一 toolCallId 不应产生两条 tool 结果', () => {
    it('未授予工具', async () => {
      const { options } = opts([
        { toolCalls: [{ name: 'fixture_apply', input: { name: 'reset' } }] },
        { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
      ]);
      const r = await runAgent(options);
      assertEachToolCallHasExactlyOneResult(r.messages);
    });

    it('正常工具', async () => {
      const { options } = opts([
        { toolCalls: [{ name: 'echo', input: { x: 1 } }] },
        { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
      ]);
      const r = await runAgent(options);
      assertEachToolCallHasExactlyOneResult(r.messages);
    });

    it('finish', async () => {
      const { options } = opts([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
      const r = await runAgent(options);
      assertEachToolCallHasExactlyOneResult(r.messages);
    });
  });

  describe('finish / report_blocked 与其他调用同轮时互斥', () => {
    it('[finish, echo]：echo 不执行，且累计不合格后 BLOCKED（不会 done）', async () => {
      const bad = { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }, { name: 'echo', input: { x: 1 } }] };
      const { options } = opts([bad, bad, bad]);
      const r = await runAgent(options);
      expect(echo.execute).not.toHaveBeenCalled();
      expect(r.status).not.toBe('done');
      expect(r).toMatchObject({ status: 'blocked', reason: 'invalid-output' });
    });

    it('[report_blocked, echo]：echo 不执行，结果 blocked reported', async () => {
      const { options } = opts([
        { toolCalls: [{ name: 'report_blocked', input: { reason: '登录页 500' } }, { name: 'echo', input: { x: 1 } }] },
      ]);
      const r = await runAgent(options);
      expect(echo.execute).not.toHaveBeenCalled();
      expect(r).toMatchObject({ status: 'blocked', reason: 'reported', detail: '登录页 500' });
    });

    it('[report_blocked, finish]：finish 不被采纳，结果 blocked reported', async () => {
      const { options } = opts([
        { toolCalls: [{ name: 'report_blocked', input: { reason: '登录页 500' } }, { name: 'finish', input: { answer: 'ok' } }] },
      ]);
      const r = await runAgent(options);
      expect(r).toMatchObject({ status: 'blocked', reason: 'reported', detail: '登录页 500' });
    });
  });

  describe('预算：单次调用超出 token / 时长后即判为 budget', () => {
    it('单次调用的 token 用量超出预算时，即使 finish 合法也判为 budget', async () => {
      const { options } = opts([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }], {
        budget: new BudgetTracker({ steps: 10, tokens: 10, minutes: 10 }),
      });
      const r = await runAgent(options);
      expect(r).toMatchObject({ status: 'blocked', reason: 'budget' });
    });

    it('模型调用因预算超时被中止时，主模型只调用一次、备用模型未被调用，判为 budget（不重试、不切换）', async () => {
      const primary = scriptedModel([{ hang: true }]);
      const backup = scriptedModel([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
      let current = 0;
      const now = () => current;
      const budget = new BudgetTracker({ steps: 10, tokens: 1_000_000, minutes: 1 }, now);
      current = 60_000 - 20; // 把“已用时长”推到只剩 20ms 预算
      const { options } = opts([], {
        models: [
          { ref: 'mock:primary', model: primary },
          { ref: 'mock:backup', model: backup },
        ],
        budget,
        resilience: { retries: 3, sleep: async () => {} },
      });
      const r = await runAgent(options);
      expect(r).toMatchObject({ status: 'blocked', reason: 'budget' });
      expect(primary.doGenerateCalls).toHaveLength(1);
      expect(backup.doGenerateCalls).toHaveLength(0);
    });

    it('模型调用因预算超时被中止，即使底层错误不带 AbortError/TimeoutError 名字，也不重试、不切换', async () => {
      const primary = scriptedModel([{ hangWithGenericError: true }]);
      const backup = scriptedModel([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
      let current = 0;
      const now = () => current;
      const budget = new BudgetTracker({ steps: 10, tokens: 1_000_000, minutes: 1 }, now);
      current = 60_000 - 20;
      const { options } = opts([], {
        models: [
          { ref: 'mock:primary', model: primary },
          { ref: 'mock:backup', model: backup },
        ],
        budget,
        resilience: { retries: 3, sleep: async () => {} },
      });
      const r = await runAgent(options);
      expect(r).toMatchObject({ status: 'blocked', reason: 'budget' });
      expect(primary.doGenerateCalls).toHaveLength(1);
      expect(backup.doGenerateCalls).toHaveLength(0);
    });

    it('工具执行挂起且时长预算即将耗尽时判为 budget（而非一直挂起）', async () => {
      const hang = defineTool({
        name: 'hang',
        category: 'browser',
        description: '永远挂起，直到收到中断信号才结束',
        input: z.object({}),
        execute: (_input, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('工具收到中断信号')), { once: true });
          }),
      });
      let current = 0;
      const now = () => current;
      const budget = new BudgetTracker({ steps: 10, tokens: 1_000_000, minutes: 1 }, now);
      current = 60_000 - 20; // 构造后立刻把“已用时长”推到只剩 20ms 预算
      const { options } = opts([{ toolCalls: [{ name: 'hang', input: {} }] }], { tools: [hang], budget });
      const r = await runAgent(options);
      expect(r).toMatchObject({ status: 'blocked', reason: 'budget' });
    });
  });

  it('中断发生在本轮第一个工具执行期间时，第二个工具不会执行', async () => {
    const ac = new AbortController();
    const stopper = defineTool({
      name: 'stopper',
      category: 'browser',
      description: '执行期间触发外部中断',
      input: z.object({}),
      execute: async () => {
        ac.abort();
        return 'stopped';
      },
    });
    const second = defineTool({
      name: 'second_tool',
      category: 'browser',
      description: '不应被执行',
      input: z.object({}),
      execute: vi.fn(async () => 'should-not-run'),
    });
    const { options } = opts(
      [{ toolCalls: [{ name: 'stopper', input: {} }, { name: 'second_tool', input: {} }] }],
      { tools: [stopper, second], signal: ac.signal },
    );
    const r = await runAgent(options);
    expect(second.execute).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'blocked', reason: 'interrupted' });
  });

  it('onToolCall 也为 finish 和 report_blocked 发事件', async () => {
    const events: Array<{ name: string; ok: boolean }> = [];
    const { options } = opts([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }], {
      onToolCall: (e) => { events.push(e); },
    });
    await runAgent(options);
    expect(events).toContainEqual(expect.objectContaining({ name: 'finish', ok: true }));
  });

  it('工具执行成功但结果无法序列化时，事件 ok:true 且回复说明无法序列化（不算执行失败）', async () => {
    const unserializable = defineTool({
      name: 'unserializable',
      category: 'browser',
      description: '返回无法 JSON 序列化的结果',
      input: z.object({}),
      execute: async () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        return circular;
      },
    });
    const events: Array<{ name: string; ok: boolean; error?: string }> = [];
    const { model, options } = opts(
      [{ toolCalls: [{ name: 'unserializable', input: {} }] }, { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }],
      { tools: [unserializable], onToolCall: (e) => { events.push(e); } },
    );
    await runAgent(options);
    expect(events[0]).toMatchObject({ name: 'unserializable', ok: true });
    expect(events[0]?.error).toContain('无法序列化');
    expect(promptText(model, 1)).toContain('无法序列化');
  });
});
