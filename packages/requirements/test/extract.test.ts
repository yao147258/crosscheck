import { BudgetTracker } from '@crosscheck/core';
import { describe, expect, it } from 'vitest';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import { extractRequirements } from '../src/index';

const clause = { id: 'M01-AC-001', text: '必须登录', source: { file: 'req.md', line: 1, excerpt: '必须登录' } };
const finish = (input: unknown): ScriptStep => ({ toolCalls: [{ name: 'finish', input }] });
const documents = [{ file: 'req.md', text: '必须登录\r\n禁止匿名' }];

function setup(steps: ScriptStep[]) {
  const model = scriptedModel(steps);
  return {
    model,
    options: {
      module: 'M01', documents: documents.map((d) => ({ ...d })),
      models: [{ ref: 'mock:extractor', model }],
      budget: new BudgetTracker({ steps: 10, tokens: 10000, minutes: 1 }),
      resilience: { retries: 0, sleep: async () => {} },
    },
  };
}

describe('extractRequirements', () => {
  it('返回带来源的草稿，并将输入文档作为 JSON 提供给模型', async () => {
    const { model, options } = setup([finish([clause])]);
    const result = await extractRequirements(options);
    expect(result).toMatchObject({ status: 'done', output: [{ ...clause, status: 'active' }], steps: 1, retried: false });
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('禁止匿名');
    const tools = model.doGenerateCalls[0]?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual(['finish', 'report_blocked']);
    expect(options.documents).toEqual(documents);
  });

  it('虚构来源被反馈后可以修正', async () => {
    const { model, options } = setup([finish([{ ...clause, source: { ...clause.source, file: 'other.md' } }]), finish([clause])]);
    const result = await extractRequirements(options);
    expect(result).toMatchObject({ status: 'done', steps: 2, output: [{ id: 'M01-AC-001' }] });
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('来源文件不在输入文档中');
  });

  it('连续三次虚构摘录后返回 invalid-output', async () => {
    const bad = finish([{ ...clause, source: { ...clause.source, excerpt: '虚构内容' } }]);
    const { model, options } = setup([bad, bad, bad, finish([clause])]);
    expect(await extractRequirements(options)).toMatchObject({ status: 'blocked', reason: 'invalid-output', steps: 3 });
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it('模块越界被反馈且可修正', async () => {
    const { model, options } = setup([finish([{ ...clause, id: 'M02-AC-001' }]), finish([clause])]);
    expect(await extractRequirements(options)).toMatchObject({ status: 'done', steps: 2 });
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('条款 ID 不属于指定模块');
  });

  it('拒绝读取文件或访问网络等未授予的工具', async () => {
    const { model, options } = setup([
      { toolCalls: [{ name: 'read_file', input: { path: 'src/index.ts' } }, { name: 'http', input: { url: 'https://example.com' } }] },
      finish([clause]),
    ]);
    expect(await extractRequirements(options)).toMatchObject({ status: 'done', steps: 2 });
    const prompt = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(prompt).toContain('read_file 在 extract 阶段未授予');
    expect(prompt).toContain('http 在 extract 阶段未授予');
  });

  it('保留模型主动上报的障碍', async () => {
    const { options } = setup([{ toolCalls: [{ name: 'report_blocked', input: { reason: '需求不完整' } }] }]);
    expect(await extractRequirements(options)).toMatchObject({ status: 'blocked', reason: 'reported', detail: '需求不完整' });
  });

  it('预算耗尽时返回 budget', async () => {
    const { options } = setup([finish([clause])]);
    options.budget = new BudgetTracker({ steps: 10, tokens: 10, minutes: 1 });
    expect(await extractRequirements(options)).toMatchObject({ status: 'blocked', reason: 'budget' });
  });

  it('已取消时返回 interrupted 且不调用模型', async () => {
    const { model, options } = setup([]);
    const controller = new AbortController();
    controller.abort();
    expect(await extractRequirements({ ...options, signal: controller.signal })).toMatchObject({ status: 'blocked', reason: 'interrupted', steps: 0 });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('已取消时优先于非法输入，且不读取文档或调用模型', async () => {
    const { model, options } = setup([]);
    const controller = new AbortController();
    controller.abort();
    const input = {
      ...options,
      module: 'bad-module',
      models: [],
      signal: controller.signal,
      get documents(): typeof documents { throw new Error('不应读取文档'); },
    };
    expect(await extractRequirements(input)).toEqual({
      status: 'blocked', reason: 'interrupted', detail: '执行被中断',
      steps: 0, retried: false, messages: [],
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('非法输入和空模型列表在调用模型前拒绝', async () => {
    const { model, options } = setup([]);
    await expect(extractRequirements({ ...options, module: 'bad-module' })).rejects.toThrow();
    await expect(extractRequirements({ ...options, documents: [] })).rejects.toThrow();
    await expect(extractRequirements({ ...options, models: [] })).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
