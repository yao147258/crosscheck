import { BudgetTracker } from '@crosscheck/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, runAgent, SUBAGENT_NOTICE, type RunAgentOptions } from '../src/index';
import { scriptedModel, type ScriptStep } from '../src/testing/scripted-model';

const Output = z.object({ answer: z.string() });
const look = defineTool({ name: 'look', category: 'browser', description: '观察页面', input: z.object({}), execute: async () => ({ evidenceIds: ['e1'] }) });
const fixture = defineTool({ name: 'fixture_apply', category: 'fixture', description: '造数', input: z.object({}), execute: async () => 'done' });
const REPORT = { summary: '设置页有保存按钮', findings: [{ text: '保存按钮', evidenceIds: ['e1', 'fake'] }], status: 'done' };
const explore = { name: 'explore', description: '把页面探索委派给子代理', tools: ['look'] };

function setup(steps: ScriptStep[], over: Partial<RunAgentOptions<z.infer<typeof Output>>> = {}) {
  const model = scriptedModel(steps);
  const options: RunAgentOptions<z.infer<typeof Output>> = {
    stage: 'execute', models: [{ ref: 'mock:a', model }], system: '你是测试员',
    messages: [{ role: 'user', content: '父任务机密上下文' }], tools: [look, fixture], output: Output,
    budget: new BudgetTracker({ steps: 20, tokens: 1_000_000, minutes: 10 }), resilience: { retries: 0, sleep: async () => {} },
    delegates: [explore], agentId: 'root', ...over,
  };
  return { model, options };
}

describe('delegate 工具', () => {
  it('父代理调用 delegate，子代理在隔离上下文中完成，结论带标记且证据 ID 经核验', async () => {
    const { model, options } = setup([
      { toolCalls: [{ name: 'explore', input: { task: '打开设置页' } }] }, // 父
      { toolCalls: [{ name: 'look', input: {} }] },                        // 子
      { toolCalls: [{ name: 'finish', input: REPORT }] },                   // 子
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },         // 父
    ], {
      verifyEvidenceIds: async ids => ids.filter(id => id === 'e1'),
      // 父代理默认要求已知证据完整呈现，须能物化 e1 才能 finish。
      evidencePresenter: async ids => ids.map(id => ({ id, type: 'dom' as const, text: '页面', truncated: false })),
    });
    const r = await runAgent(options);
    expect(r.status).toBe('done');
    const child = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(child).toContain('打开设置页');
    expect(child).not.toContain('父任务机密上下文');
    const parentNext = JSON.stringify(model.doGenerateCalls[3]!.prompt);
    expect(parentNext).toContain(SUBAGENT_NOTICE);
    expect(parentNext).toContain('已丢弃无效证据ID: fake');
  });

  it('子代理工具集不含 delegate，模板越权在调用模型前抛错', async () => {
    const { model, options } = setup([{ toolCalls: [{ name: 'explore', input: { task: 't' } }] }, { toolCalls: [{ name: 'finish', input: REPORT }] }, { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    await runAgent(options);
    expect(JSON.stringify(model.doGenerateCalls[0]!.tools)).toContain('"explore"');
    expect(JSON.stringify(model.doGenerateCalls[1]!.tools)).not.toContain('"explore"');
    const bad = setup([], { delegates: [{ name: 'explore', description: 'x', tools: ['fixture_apply'] }] });
    await expect(runAgent(bad.options)).rejects.toThrow(/未授予/);
    expect(bad.model.doGenerateCalls).toHaveLength(0);
  });

  it('子代理中不允许再配置 delegates', async () => {
    const { options } = setup([], { parentId: 'p' });
    await expect(runAgent(options)).rejects.toThrow(/不能再派生/);
  });

  it('子代理阻断时父代理收到错误结果并可继续', async () => {
    const { model, options } = setup([
      { toolCalls: [{ name: 'explore', input: { task: 't' } }] },
      { toolCalls: [{ name: 'report_blocked', input: { reason: '需要验证码' } }] },
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
    ]);
    const r = await runAgent(options);
    expect(r.status).toBe('done');
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toContain('需要验证码');
  });

  it('子代理宿主异常使父代理抛出原错误，且每个调用都有结果', async () => {
    const error = new Error('磁盘满');
    let n = 0;
    const { options } = setup([{ toolCalls: [{ name: 'explore', input: { task: 't' } }] }, { toolCalls: [{ name: 'finish', input: REPORT }] }], {
      onModelAttempt: () => { if (++n === 2) throw error; },
    });
    await expect(runAgent(options)).rejects.toBe(error);
  });

  it('review 阶段配置任何 delegate 模板都在调用模型前抛错', async () => {
    for (const tools of [[], ['look']]) {
      const { model, options } = setup([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }], { stage: 'review', delegates: [{ name: 'explore', description: 'x', tools }] });
      await expect(runAgent(options)).rejects.toThrow(/review 阶段不允许派生子代理/);
      expect(model.doGenerateCalls).toHaveLength(0);
    }
  });

  it('delegate 名称与已有工具冲突时抛错', async () => {
    const { options } = setup([], { delegates: [{ name: 'look', description: 'x', tools: [] }] });
    await expect(runAgent(options)).rejects.toThrow(/重复/);
  });
});
