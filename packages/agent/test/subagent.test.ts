import { randomUUID } from 'node:crypto';
import { BudgetTracker } from '@crosscheck/core';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, runSubAgents, spawnSubAgent, type ModelAttempt, type ParentContext, type SubAgentFinishedEvent } from '../src/index';
import { scriptedModel, type ScriptStep } from '../src/testing/scripted-model';

const echo = defineTool({ name: 'echo', category: 'profile', description: '原样返回', input: z.object({}), execute: async () => ({ evidenceIds: ['e1'] }) });
const REPORT = { summary: '已到达设置页', findings: [{ text: '有保存按钮', evidenceIds: ['e1', 'fake'] }], status: 'done' };

function parent(model: ParentContext['models'][number]['model'], over: Partial<ParentContext> = {}): ParentContext {
  return {
    stage: 'execute', models: [{ ref: 'mock:a', model }], tools: [echo],
    budget: new BudgetTracker({ steps: 10, tokens: 1_000, minutes: 10 }), signal: new AbortController().signal,
    agentId: 'root', resilience: { retries: 0, sleep: async () => {} }, ...over,
  };
}
const finishWith = (input: unknown): ScriptStep => ({ toolCalls: [{ name: 'finish', input }] });

describe('spawnSubAgent', () => {
  it('申请父阶段未授予的工具时在调用模型前抛错', async () => {
    const model = scriptedModel([]);
    await expect(spawnSubAgent(parent(model), { name: 'x', task: 't', tools: ['fixture_apply'] })).rejects.toThrow(/未授予/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('子代理不能再派生子代理', async () => {
    await expect(spawnSubAgent(parent(scriptedModel([]), { parentId: 'p' }), { name: 'x', task: 't', tools: [] })).rejects.toThrow(/不能再派生/);
  });

  it('只接收任务与上下文，回传经核验的证据 ID', async () => {
    const model = scriptedModel([finishWith(REPORT)]);
    const r = await spawnSubAgent(parent(model, { verifyEvidenceIds: async ids => ids.filter(id => id === 'e1') }), { name: 'explore', task: '打开设置页', context: { url: '/settings' }, tools: ['echo'] });
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain('打开设置页');
    expect(r).toMatchObject({ status: 'done', evidenceIds: ['e1'], droppedEvidenceIds: ['fake'] });
    expect(r.status === 'done' && r.output.findings[0]!.evidenceIds).toEqual(['e1']);
  });

  it('未提供 verifyEvidenceIds 时默认拒绝全部声称的证据 ID', async () => {
    const r = await spawnSubAgent(parent(scriptedModel([finishWith(REPORT)])), { name: 'explore', task: 't', tools: [] });
    expect(r).toMatchObject({ status: 'done', evidenceIds: [], droppedEvidenceIds: ['e1', 'fake'] });
    expect(r.status === 'done' && r.output.findings[0]!.evidenceIds).toEqual([]);
  });

  it('子账本消耗同时计入父账本，事件带 agentId 与 parentId', async () => {
    const attempts: ModelAttempt[] = [];
    const finished: SubAgentFinishedEvent[] = [];
    const p = parent(scriptedModel([finishWith(REPORT)]), { onModelAttempt: a => { attempts.push(a); }, onSubAgentFinished: e => { finished.push(e); } });
    const r = await spawnSubAgent(p, { name: 'explore', task: 't', tools: [] });
    expect(p.budget.snapshot()).toMatchObject({ steps: 1, tokens: 15 });
    expect(attempts[0]).toMatchObject({ parentId: 'root', agentId: r.agentId });
    expect(r.agentId.startsWith('root/explore-')).toBe(true);
    expect(finished).toEqual([{ name: 'explore', agentId: r.agentId, parentId: 'root', status: 'done' }]);
  });

  it('子代理上报障碍时返回 blocked，不抛错', async () => {
    const r = await spawnSubAgent(parent(scriptedModel([{ toolCalls: [{ name: 'report_blocked', input: { reason: '需要验证码' } }] }])), { name: 'explore', task: 't', tools: [] });
    expect(r).toMatchObject({ status: 'blocked', reason: 'reported', detail: '需要验证码' });
  });

  it('子代理预算受 cap 限制', async () => {
    const r = await spawnSubAgent(parent(scriptedModel([{ toolCalls: [{ name: 'echo', input: {} }] }, finishWith(REPORT)])), { name: 'explore', task: 't', tools: ['echo'], cap: { tokens: 1 } });
    expect(r).toMatchObject({ status: 'blocked', reason: 'budget' });
  });

  it('宿主异常原样透传', async () => {
    const error = new Error('磁盘满');
    const p = parent(scriptedModel([finishWith(REPORT)]), { onModelAttempt: () => { throw error; } });
    await expect(spawnSubAgent(p, { name: 'explore', task: 't', tools: [] })).rejects.toBe(error);
  });
});

/** 按 prompt 决定动作：尚无工具结果时调用 slow，否则提交报告；可被多个子代理并发共享。 */
function reactiveModel() {
  return new MockLanguageModelV4({
    doGenerate: async options => {
      const done = JSON.stringify(options.prompt).includes('tool-result');
      const call = done ? { name: 'finish', input: { summary: 's', findings: [], status: 'done' } } : { name: 'slow', input: {} };
      return {
        content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName: call.name, input: JSON.stringify(call.input) }],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } },
        warnings: [],
      };
    },
  });
}

describe('runSubAgents', () => {
  it('遵守并发上限并逐项返回', async () => {
    let active = 0; let peak = 0;
    const slow = defineTool({ name: 'slow', category: 'profile', description: '慢', input: z.object({}), execute: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 20));
      active--; return {};
    } });
    const p = parent(reactiveModel(), { tools: [slow], budget: new BudgetTracker({ steps: 20, tokens: 1_000, minutes: 10 }) });
    const results = await runSubAgents(p, [1, 2, 3].map(i => ({ name: `s${i}`, task: `任务${i}`, tools: ['slow'] })), { concurrency: 2 });
    expect(results.map(r => r.status)).toEqual(['done', 'done', 'done']);
    expect(peak).toBe(2);
  });

  it('部分子代理预算耗尽时其余照常完成', async () => {
    const slow = defineTool({ name: 'slow', category: 'profile', description: '慢', input: z.object({}), execute: async () => ({}) });
    const p = parent(reactiveModel(), { tools: [slow] });
    const results = await runSubAgents(p, [{ name: 'a', task: 'a', tools: ['slow'] }, { name: 'b', task: 'b', tools: ['slow'], cap: { tokens: 1 } }]);
    expect(results.map(r => r.status)).toEqual(['done', 'blocked']);
  });

  it('越权申请在任何子代理启动前抛错', async () => {
    const model = reactiveModel();
    await expect(runSubAgents(parent(model), [{ name: 'a', task: 'a', tools: [] }, { name: 'b', task: 'b', tools: ['nope'] }])).rejects.toThrow(/未授予/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('任一子代理宿主异常时取消其余并抛出该异常', async () => {
    const error = new Error('磁盘满');
    const onModelAttempt = vi.fn(() => { throw error; });
    const slow = defineTool({ name: 'slow', category: 'profile', description: '慢', input: z.object({}), execute: async () => ({}) });
    await expect(runSubAgents(parent(reactiveModel(), { tools: [slow], onModelAttempt }), [{ name: 'a', task: 'a', tools: ['slow'] }, { name: 'b', task: 'b', tools: ['slow'] }])).rejects.toBe(error);
  });
});
