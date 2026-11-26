import { BudgetTracker } from '@crosscheck/core';
import { builtinFactories, createUsageObservationScope, withProgress, type UsageAttempt } from '@crosscheck/models';
import { generateText, type ModelMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ContextManager, createModelSummarizer, defineTool, runAgent, type RunAgentOptions } from '../src/index';
import { scriptedModel, type ScriptStep } from '../src/testing/scripted-model';

vi.mock(import('ai'), { spy: true });

const realGenerateText = (await vi.importActual<typeof import('ai')>('ai')).generateText;

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
    const usageObserver = vi.fn();
    const { model, options } = opts([], { usageObserver });
    const r = await runAgent({ ...options, models: [{ ref: 'mock:tiny[1K]', model, contextWindow: 1_000 }], messages: [{ role: 'user', content: '中'.repeat(5_000) }] });
    expect(usageObserver).not.toHaveBeenCalled();
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
    const usageObserver = vi.fn();
    const { model, options } = opts([], { signal: ac.signal, usageObserver });
    expect(await runAgent(options)).toMatchObject({ status: 'blocked', reason: 'interrupted' });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(usageObserver).not.toHaveBeenCalled();
  });

  it('本地空消息守卫不进入 SDK，不计账、不审计、不重试或切换候选', async () => {
    const usageObserver = vi.fn();
    const onModelAttempt = vi.fn();
    const sleep = vi.fn(async () => {});
    const onFallback = vi.fn();
    const backup = scriptedModel([]);
    const { model, options } = opts([], { messages: [], usageObserver, onModelAttempt, resilience: { retries: 2, sleep, onFallback } });
    const result = await runAgent({ ...options, models: [...options.models, { ref: 'mock:backup', model: backup }] });
    expect(result).toMatchObject({ status: 'blocked', reason: 'model-error', detail: expect.stringContaining('empty'), attempts: 0, modelAttempts: [], retried: false });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(backup.doGenerateCalls).toHaveLength(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
    expect(usageObserver).not.toHaveBeenCalled();
    expect(onModelAttempt).not.toHaveBeenCalled();
  });

  it.each([false, true])('主候选图片预下载失败只计旧审计；审计异常可阻断备用（%s）', async auditFails => {
    const url = new URL('https://example.com/image.png');
    const usage: UsageAttempt[] = [];
    const auditError = new Error('审计写入失败');
    const onModelAttempt = vi.fn(() => { if (auditFails) throw auditError; });
    const onFallback = vi.fn();
    const download = vi.fn<NonNullable<Parameters<typeof generateText>[0]['experimental_download']>>(async requests =>
      requests.map(request => {
        if (!request.isUrlSupportedByModel) throw new Error('图片下载失败');
        return null;
      }));
    const backup = scriptedModel([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    Object.defineProperty(backup, 'supportedUrls', { value: { 'image/png': [/^https:\/\/example\.com\//] } });
    const { model, options } = opts([], {
      messages: [{ role: 'user', content: [{ type: 'file', data: url, mediaType: 'image/png' }] }],
      usageObserver: attempt => { usage.push(attempt); }, onModelAttempt,
      resilience: { retries: 0, onFallback },
    });
    vi.mocked(generateText).mockImplementation(options => realGenerateText({ ...options, experimental_download: download }));
    try {
      const pending = runAgent({ ...options, models: [...options.models, { ref: 'mock:backup', model: backup }] });
      const primaryError = { ref: 'mock:primary', status: 'error', usage: null };
      if (auditFails) {
        await expect(pending).rejects.toBe(auditError);
        expect(onModelAttempt.mock.calls).toEqual([[primaryError]]);
        expect(onFallback).not.toHaveBeenCalled();
        expect(backup.doGenerateCalls).toHaveLength(0);
        expect(usage).toEqual([]);
        return;
      }
      const result = await pending;
      expect(download).toHaveBeenNthCalledWith(1, [{ url, isUrlSupportedByModel: false }]);
      expect(result).toMatchObject({ status: 'done', output: { answer: 'ok' }, attempts: 2, retried: true, modelAttempts: [primaryError, { ref: 'mock:backup', status: 'success' }] });
      expect(download).toHaveBeenNthCalledWith(2, [{ url, isUrlSupportedByModel: true }]);
      expect(onFallback).toHaveBeenCalledWith('mock:primary', 'mock:backup', expect.objectContaining({ message: '图片下载失败' }));
      expect(model.doGenerateCalls).toHaveLength(0);
      expect(backup.doGenerateCalls).toHaveLength(1);
      expect(promptText(backup, 0)).toContain(url.href);
      expect(usage).toEqual([{ ref: 'mock:backup', status: 'success', purpose: 'request', usage: { inputTokens: 10, outputTokens: 5 } }]);
      expect(onModelAttempt.mock.calls).toEqual([[primaryError], [{ ref: 'mock:backup', status: 'success', usage: { inputTokens: 10, outputTokens: 5 } }]]);
    } finally {
      vi.mocked(generateText).mockReset();
    }
  });

  it.each(['openai', 'anthropic'] as const)('内置 %s 拒绝本地文件转换时只走旧审计，不入账', async type => {
    const fetch = vi.fn(async () => { throw new Error('不应进入 fetch'); });
    const model = builtinFactories[type]({ name: type, modelId: 'test', baseURL: 'https://example.invalid/v1', apiKey: 'fixture-key', fetch });
    const onModelAttempt = vi.fn();
    const usageObserver = vi.fn();
    const ref = `${type}:test`;
    const { options } = opts([], {
      models: [{ ref, model }], onModelAttempt, usageObserver,
      messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'application/zip', data: new Uint8Array([1, 2, 3]) }] }],
    });
    const result = await runAgent(options);
    const attempt = { ref, status: 'error', usage: null };
    expect(result).toMatchObject({ status: 'blocked', reason: 'model-error', detail: expect.stringContaining('application/zip'), attempts: 1, modelAttempts: [attempt] });
    expect(fetch).not.toHaveBeenCalled();
    expect(onModelAttempt.mock.calls).toEqual([[attempt]]);
    expect(usageObserver).not.toHaveBeenCalled();
  });

  it('并行复用同一内置模型时，后进入的本地失败不覆盖先进入调用的 fetch 与回执', async () => {
    let notifyGenerate!: () => void;
    let releaseGenerate!: () => void;
    const entered = new Promise<void>(resolve => { notifyGenerate = resolve; });
    const hold = new Promise<void>(resolve => { releaseGenerate = resolve; });
    const fetch = vi.fn(async () => Response.json({ usage: { input_tokens: 21, output_tokens: 8 } }));
    const model = builtinFactories.openai({ name: 'openai', modelId: 'test', baseURL: 'https://example.invalid/v1', apiKey: 'fixture-key', fetch });
    if (typeof model === 'string' || model.specificationVersion !== 'v4') throw new Error('预期内置 V4 模型');
    const generate = model.doGenerate.bind(model);
    vi.spyOn(model, 'doGenerate').mockImplementationOnce(async options => {
      notifyGenerate();
      await hold;
      return generate(options);
    });
    const models = [{ ref: 'openai:test', model }];
    const sent = vi.fn();
    const local = vi.fn();
    const pending = runAgent(opts([], { models, usageObserver: sent }).options);
    try {
      await Promise.race([entered, pending.then(() => { throw new Error('模型未进入 doGenerate'); })]);
      const result = await runAgent(opts([], {
        models, usageObserver: local,
        messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'application/zip', data: new Uint8Array([1, 2, 3]) }] }],
      }).options);
      expect(result).toMatchObject({ status: 'blocked', detail: expect.stringContaining('application/zip') });
      expect(local).not.toHaveBeenCalled();
    } finally { releaseGenerate(); }
    expect(await pending).toMatchObject({ status: 'blocked', reason: 'model-error' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls).toEqual([[{ ref: 'openai:test', purpose: 'request', status: 'error', usage: { inputTokens: 21, outputTokens: 8 } }]]);
  });

  it('预算已耗尽时不调用模型且不记录用量', async () => {
    const budget = new BudgetTracker({ steps: 1, tokens: 1_000, minutes: 10 });
    budget.recordStep();
    const usageObserver = vi.fn();
    const { model, options } = opts([], { budget, usageObserver });
    expect(await runAgent(options)).toMatchObject({ status: 'blocked', reason: 'budget', attempts: 0 });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(usageObserver).not.toHaveBeenCalled();
  });

  it('请求进度回调中取消时仍属于预取消，不调用模型且不记录用量', async () => {
    const ac = new AbortController();
    const usageObserver = vi.fn();
    const { model, options } = opts([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }], { signal: ac.signal, usageObserver });
    const result = await withProgress(() => ac.abort(), () => runAgent(options));
    expect(result).toMatchObject({ status: 'blocked', reason: 'interrupted', attempts: 0 });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(usageObserver).not.toHaveBeenCalled();
  });

  it('主模型重试后切换备用模型，每个真实请求只上报一次用量', async () => {
    const usage: UsageAttempt[] = [];
    const primary = scriptedModel(Array.from({ length: 3 }, () => ({ error: new Error('503') })));
    const backup = scriptedModel([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    const { options } = opts([], {
      models: [
        { ref: 'mock:primary', model: primary },
        { ref: 'mock:backup', model: backup },
      ],
      resilience: { retries: 2, sleep: async () => {} },
      usageObserver: attempt => { usage.push(attempt); },
    });
    const r = await runAgent(options);
    expect(r).toMatchObject({ status: 'done', retried: true });
    expect(primary.doGenerateCalls).toHaveLength(3);
    expect(usage).toEqual([
      { ref: 'mock:primary', purpose: 'request', status: 'error', usage: null },
      { ref: 'mock:primary', purpose: 'request', status: 'error', usage: null },
      { ref: 'mock:primary', purpose: 'request', status: 'error', usage: null },
      { ref: 'mock:backup', purpose: 'request', status: 'success', usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  it('SDK 后处理失败时账本保留原始回执，严格审计仍记为未知用量', async () => {
    const usageObserver = vi.fn();
    const onModelAttempt = vi.fn();
    const { model, options } = opts([{ text: '不会显示', usage: { input: 19, output: 7, cacheRead: 0, cacheWrite: 2 } }], { usageObserver, onModelAttempt });
    const generate = model.doGenerate.bind(model);
    vi.spyOn(model, 'doGenerate').mockImplementation(async options => ({
      ...await generate(options),
      get content(): never { throw new Error('SDK 后处理读取内容失败'); },
    }));
    const result = await runAgent(options);
    expect(result).toMatchObject({ status: 'blocked', reason: 'model-error', detail: 'SDK 后处理读取内容失败' });
    expect(onModelAttempt.mock.calls).toEqual([[{ ref: 'mock:primary', status: 'error', usage: null }]]);
    expect(usageObserver.mock.calls).toEqual([[{ ref: 'mock:primary', purpose: 'request', status: 'error', usage: { inputTokens: 19, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 2 } }]]);
  });

  it.each([false, true])('用量观察者拒绝不影响宿主审计及其阻断行为（审计失败：%s）', async (auditFails) => {
    const seen: UsageAttempt[] = [];
    const auditError = new Error('磁盘满');
    const onModelAttempt = vi.fn(() => { if (auditFails) throw auditError; });
    const { options } = opts([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }], usage: { input: 100, cacheRead: 60, cacheWrite: 0 } }], {
      usageObserver: async attempt => { seen.push(attempt); throw new Error('账本不可用'); },
      onModelAttempt,
    });
    const result = runAgent(options);
    if (auditFails) await expect(result).rejects.toBe(auditError);
    else await expect(result).resolves.toMatchObject({ status: 'done', output: { answer: 'ok' }, attempts: 1 });
    const usage = { inputTokens: 100, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 0 };
    expect(seen).toEqual([{ ref: 'mock:primary', purpose: 'request', status: 'success', usage }]);
    expect(onModelAttempt.mock.calls).toEqual([[{ ref: 'mock:primary', status: 'success', usage }]]);
  });

  it.each([false, true])('慢观察者在业务及严格审计结束后才执行，返回前排空（审计失败：%s）', async (auditFails) => {
    const phases: string[] = [];
    const error = new Error('宿主审计失败');
    let now = 0;
    const budget = new BudgetTracker({ steps: 1, tokens: 1_000, minutes: 1 }, () => now);
    const { options } = opts([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }], {
      budget,
      onModelAttempt: () => { phases.push('审计'); if (auditFails) throw error; },
      onToolCall: () => { phases.push('完成'); },
      usageObserver: async () => { await Promise.resolve(); now = 60_001; phases.push('用量'); },
    });
    const result = runAgent(options);
    if (auditFails) await expect(result).rejects.toBe(error);
    else await expect(result).resolves.toMatchObject({ status: 'done', output: { answer: 'ok' } });
    expect(phases).toEqual(auditFails ? ['审计', '用量'] : ['审计', '完成', '用量']);
  });

  it('宿主可跨阶段共用排空范围，只在明确排空时通知且不重复', async () => {
    const usage: UsageAttempt[] = [];
    let now = 0;
    const budget = new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 1 }, () => now);
    const scope = createUsageObservationScope();
    for (const input of [20, 30]) {
      const { options } = opts([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }], usage: { input } }], {
        budget, usageObservationScope: scope,
        usageObserver: async attempt => { await Promise.resolve(); now = 60_001; usage.push(attempt); },
      });
      await expect(runAgent(options)).resolves.toMatchObject({ status: 'done' });
      expect(usage).toEqual([]);
    }
    await scope.flush();
    await scope.flush();
    expect(usage.map(attempt => attempt.usage?.inputTokens)).toEqual([20, 30]);
  });

  it('准备阶段取消或准备失败时不产生请求用量', async () => {
    const ac = new AbortController();
    const usage: UsageAttempt[] = [];
    const { model, options } = opts([], { usageObserver: attempt => { usage.push(attempt); } });
    const error = new Error('装配失败');
    await expect(runAgent({ ...options, onContextPrepared: () => { throw error; } })).rejects.toBe(error);
    await expect(runAgent({ ...options, signal: ac.signal, onContextPrepared: () => ac.abort() }))
      .resolves.toMatchObject({ status: 'blocked', reason: 'interrupted' });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(usage).toEqual([]);
  });

  it.each(['默认', '仅调用时提供', '调用时与构造时均提供'])('上下文摘要和随后请求分别上报（观察者：%s）', async (mode) => {
    const injected = mode !== '默认';
    const scope = createUsageObservationScope();
    const usage: UsageAttempt[] = [];
    const model = scriptedModel([
      { text: JSON.stringify({ goal: '测试', done: [], findings: [], evidenceIds: [], pending: [] }) },
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
    ]);
    const { options } = opts([], {
      stage: 'plan', models: [{ ref: 'mock:primary', model, contextWindow: 40_000 }],
      messages: [
        { role: 'user', content: '开始' },
        ...Array.from({ length: 4 }, () => ({ role: 'assistant' as const, content: 'y'.repeat(30_000) })),
        { role: 'user', content: '继续' },
      ],
      usageObserver: attempt => { usage.push(attempt); },
    });
    const contextManager = injected ? new ContextManager({
      stage: 'plan', summarize: createModelSummarizer({ budget: options.budget, usageObserver: mode === '调用时与构造时均提供' ? options.usageObserver : undefined }),
    }) : undefined;
    const result = await runAgent({ ...options, contextManager, usageObservationScope: scope });
    expect(result).toMatchObject({ status: 'done', attempts: injected ? 1 : 2 });
    expect(usage).toEqual([]);
    await scope.flush();
    expect(usage).toEqual([
      { ref: 'mock:primary', purpose: 'compact', status: 'success', usage: { inputTokens: 10, outputTokens: 5 } },
      { ref: 'mock:primary', purpose: 'request', status: 'success', usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  it('委派请求与父代理请求使用同一个观察者，不在子代理汇总时重复计数', async () => {
    const usage: UsageAttempt[] = [];
    const { options } = opts([
      { toolCalls: [{ name: 'delegate', input: { task: '检查设置' } }], usage: { input: 20 } },
      { toolCalls: [{ name: 'finish', input: { summary: '有设置', findings: [], status: 'done' } }], usage: { input: 30 } },
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }], usage: { input: 40 } },
    ], { delegates: [{ name: 'delegate', description: '委派检查', tools: [] }], usageObserver: attempt => { usage.push(attempt); } });
    expect(await runAgent(options)).toMatchObject({ status: 'done' });
    expect(usage.map(attempt => attempt.usage?.inputTokens)).toEqual([20, 30, 40]);
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
      const usage: UsageAttempt[] = [];
      const r = await runAgent({ ...options, usageObserver: attempt => { usage.push(attempt); } });
      expect(r).toMatchObject({ status: 'blocked', reason: 'budget' });
      expect(primary.doGenerateCalls).toHaveLength(1);
      expect(backup.doGenerateCalls).toHaveLength(0);
      expect(r.modelAttempts).toEqual([{ ref: 'mock:primary', status: 'error', usage: null }]);
      expect(usage).toEqual([{ ref: 'mock:primary', purpose: 'request', status: 'cancelled', usage: null }]);
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
