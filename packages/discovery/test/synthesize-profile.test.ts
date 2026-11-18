import { describe, expect, it, vi } from 'vitest';
import { BudgetTracker } from '@crosscheck/core';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import { synthesizeProfile, type DiscoveryFact } from '../src/index';

const FILES = {
  'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:3000', healthcheck: 'http://localhost:3000/health', reset: null } } },
  'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } },
  'api-catalog.yaml': { version: 1, operations: {} },
  'pages.yaml': { version: 1, pages: {} },
  'data-model.yaml': { version: 1, queries: {} },
  'fixtures.yaml': { version: 1, fixtures: {} },
  'guardrails.yaml': { allowedHosts: ['localhost:3000'] },
};
const pick = (...names: (keyof typeof FILES)[]) => Object.fromEntries(names.map((name) => [name, FILES[name]]));
const finish = (input: unknown): ScriptStep => ({ toolCalls: [{ name: 'finish', input }] });
const ALL_STEPS = [
  finish(pick('environments.yaml')), finish(pick('auth.yaml')), finish(pick('api-catalog.yaml', 'pages.yaml')),
  finish(pick('data-model.yaml', 'fixtures.yaml')), finish(pick('guardrails.yaml')),
];
const facts: DiscoveryFact[] = [
  { kind: 'port', port: 3000, plugin: 'static-scan', source: { file: 'docker-compose.yml', line: 3, excerpt: '3000:3000' } },
  { kind: 'api', method: 'GET', path: '/orders', summary: '订单列表', parameters: [], servers: [], plugin: 'openapi', source: { file: 'openapi.yaml', line: 5, excerpt: '/orders' } },
];
function payload(model: ReturnType<typeof scriptedModel>, index: number) {
  const user = model.doGenerateCalls[index]!.prompt.find((message) => message.role === 'user');
  if (user?.role !== 'user' || user.content[0]?.type !== 'text') throw new Error('缺少用户文本消息');
  return JSON.parse(user.content[0].text);
}
function options(model: ReturnType<typeof scriptedModel>, existing = {}) {
  return {
    facts, existing,
    models: [{ ref: 'mock:extractor', model }],
    budget: vi.fn(() => new BudgetTracker({ steps: 10, tokens: 100000, minutes: 1 })),
    resilience: { retries: 0, sleep: async () => {} },
  };
}

describe('synthesizeProfile', () => {
  it('每步注入脱敏后的确认笔记，不改变调用方文本', async () => {
    const model = scriptedModel(ALL_STEPS);
    const notes = '# 项目笔记\npassword=secret123\n普通说明';
    const result = await synthesizeProfile({ ...options(model), notes });
    for (const index of [0, 1, 2, 3, 4]) {
      expect(payload(model, index).notes).toContain('普通说明');
      expect(payload(model, index).notes).not.toContain('secret123');
      expect(payload(model, index).notes).toContain('[已隐藏]');
    }
    expect(notes).toContain('secret123');
    expect(result.crossCheck).toEqual([]);
  });

  it('发送前递归脱敏已确认与前步生成上下文，但不修改原始画像', async () => {
    const url = 'http://user:generated-secret@example.test:3000/path?token=hidden-query#hidden-fragment';
    const existing = { 'pages.yaml': { version: 1, pages: { existing: { environment: 'local', path: '/x', description: '跳转 //user:relative-secret@example.test/path?token=relative-query', knowledge: ['https:\\/\\/user:escaped-secret@example.test/path?token=escaped-query'], sources: [facts[1]!.source] } }, 'https://user:key-secret@example.test/?token=key-query': '安全内容' } };
    const before = structuredClone(existing);
    const env = { version: 1, environments: { local: { baseURL: url, healthcheck: 'http://example.test:3000/health', reset: null } } };
    const model = scriptedModel([finish({ 'environments.yaml': env }), ALL_STEPS[1]!, finish(pick('api-catalog.yaml')), ...ALL_STEPS.slice(3)]);
    const result = await synthesizeProfile(options(model, existing));
    const sent = JSON.stringify(payload(model, 1).context);
    for (const secret of ['generated-secret', 'hidden-query', 'hidden-fragment', 'relative-secret', 'relative-query', 'escaped-secret', 'escaped-query', 'key-secret', 'key-query']) expect(sent).not.toContain(secret);
    expect(sent).toContain('安全内容');
    expect(result.generated['environments.yaml']).toEqual(env);
    expect(existing).toEqual(before);
  });

  it('确认笔记的多行凭据在每次模型调用前清理', async () => {
    const model = scriptedModel(ALL_STEPS);
    await synthesizeProfile({ ...options(model), notes: '# 项目\npassword: |\n  multiline-secret\n安全文字' });
    for (let index = 0; index < 5; index++) {
      expect(payload(model, index).notes).not.toContain('multiline-secret');
      expect(payload(model, index).notes).toContain('安全文字');
    }
  });

  it('每步对之前模型生成的上下文应用注入的已知密钥清洗', async () => {
    const env = { version: 1, environments: { local: { baseURL: 'http://localhost:3000', healthcheck: 'http://localhost:3000/health', reset: null, start: { program: 'fixture-key', argv: [], env: {} } } } };
    const model = scriptedModel([finish({ 'environments.yaml': env }), ...ALL_STEPS.slice(1)]);
    const cleanContext = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('fixture-key', '[密钥]'));
    const result = await synthesizeProfile({ ...options(model), cleanContext });
    expect(JSON.stringify(payload(model, 1).context)).not.toContain('fixture-key');
    expect(JSON.stringify(payload(model, 1).context)).toContain('[密钥]');
    expect(result.generated['environments.yaml']).toEqual(env);
    expect(result.crossCheck).toEqual([]);
  });

  it('未提供笔记时载荷不含 notes', async () => {
    const model = scriptedModel(ALL_STEPS);
    await synthesizeProfile(options(model));
    for (const index of [0, 1, 2, 3, 4]) expect(Object.hasOwn(payload(model, index), 'notes')).toBe(false);
  });

  it('接受与事实完全匹配的 API 和页面来源', async () => {
    const model = scriptedModel([...ALL_STEPS.slice(0, 2), finish({
      'api-catalog.yaml': { version: 1, operations: { orders: { environment: 'local', method: 'GET', path: '/orders', description: '订单', sources: [facts[1]!.source] } } },
      'pages.yaml': { version: 1, pages: { orders: { environment: 'local', path: '/orders', description: '订单页面', sources: [facts[0]!.source] } } },
    }), ...ALL_STEPS.slice(3)]);
    const result = await synthesizeProfile(options(model));
    expect(result.steps[2]!.status).toBe('generated');
    expect(result.crossCheck).toEqual([]);
  });

  it.each([
    ['API 来源不存在', 'GET', '/orders', { file: 'other.yaml', line: 5, excerpt: '/orders' }],
    ['API method 不匹配', 'POST', '/orders', facts[1]!.source],
    ['API path 不匹配', 'GET', '/other', facts[1]!.source],
    ['API 摘录不匹配', 'GET', '/orders', { ...facts[1]!.source, excerpt: '伪造' }],
  ])('%s 时拒绝输出并允许修正重试', async (_label, method, path, source) => {
    const bad = finish({
      'api-catalog.yaml': { version: 1, operations: { orders: { environment: 'local', method, path, description: '订单', sources: [source] } } },
      ...pick('pages.yaml'),
    });
    const model = scriptedModel([...ALL_STEPS.slice(0, 2), bad, ALL_STEPS[2]!, ...ALL_STEPS.slice(3)]);
    const result = await synthesizeProfile(options(model));
    expect(model.doGenerateCalls).toHaveLength(6);
    expect(result.generated['api-catalog.yaml']).toEqual(FILES['api-catalog.yaml']);
    expect(result.crossCheck).toEqual([]);
  });

  it('每个 API 来源都必须对应相同 method 和 path 的事实', async () => {
    const other = { ...facts[1]!, method: 'POST', source: { file: 'other.yaml', line: 8, excerpt: 'POST /orders' } } as DiscoveryFact;
    const bad = finish({ 'api-catalog.yaml': { version: 1, operations: { orders: {
      environment: 'local', method: 'GET', path: '/orders', description: '订单', sources: [facts[1]!.source, other.source],
    } } }, ...pick('pages.yaml') });
    const model = scriptedModel([...ALL_STEPS.slice(0, 2), bad, ALL_STEPS[2]!, ...ALL_STEPS.slice(3)]);
    const result = await synthesizeProfile({ ...options(model), facts: [...facts, other] });
    expect(result.generated['api-catalog.yaml']).toEqual(FILES['api-catalog.yaml']);
    expect(result.steps[2]!.status).toBe('generated');
    expect(model.doGenerateCalls).toHaveLength(6);
  });

  it('页面来源错误后可重试生成正确草稿', async () => {
    const bad = finish({ ...pick('api-catalog.yaml'), 'pages.yaml': { version: 1, pages: {
      orders: { environment: 'local', path: '/orders', description: '订单', sources: [{ ...facts[1]!.source, line: 99 }] },
    } } });
    const model = scriptedModel([...ALL_STEPS.slice(0, 2), bad, ALL_STEPS[2]!, ...ALL_STEPS.slice(3)]);
    const result = await synthesizeProfile(options(model));
    expect(model.doGenerateCalls).toHaveLength(6);
    expect(result.generated['pages.yaml']).toEqual(FILES['pages.yaml']);
    expect(result.crossCheck).toEqual([]);
  });

  it('页面引用不存在的来源时整步失败，后续上下文不包含草稿', async () => {
    const bad = finish({ ...pick('api-catalog.yaml'), 'pages.yaml': { version: 1, pages: {
      orders: { environment: 'local', path: '/orders', description: '订单', sources: [{ ...facts[1]!.source, line: 99 }] },
    } } });
    const model = scriptedModel([...ALL_STEPS.slice(0, 2), bad, bad, bad, ...ALL_STEPS.slice(3)]);
    const result = await synthesizeProfile(options(model));
    expect(result.steps[2]).toMatchObject({ status: 'failed', detail: expect.stringContaining('invalid-output') });
    expect(result.generated['pages.yaml']).toBeUndefined();
    expect(payload(model, 5).context['api-catalog.yaml']).toBeUndefined();
  });

  it('保留旧的已确认画像，即使其来源不在当前事实中', async () => {
    const existing = { 'api-catalog.yaml': { version: 1, operations: { legacy: {
      environment: 'local', method: 'GET', path: '/legacy', description: '旧接口', knowledge: [],
      sources: [{ file: 'old.yaml', line: 1, excerpt: '旧来源' }],
    } } } };
    const model = scriptedModel([...ALL_STEPS.slice(0, 2), finish(pick('pages.yaml')), ...ALL_STEPS.slice(3)]);
    const result = await synthesizeProfile(options(model, existing));
    expect(result.steps[2]!.status).toBe('generated');
    expect(result.crossCheck).toEqual([]);
    expect(payload(model, 2).context['api-catalog.yaml']).toEqual(existing['api-catalog.yaml']);
  });
  it('按依赖顺序分 5 步生成，每步独立预算并携带前序结果和相关事实', async () => {
    const model = scriptedModel(ALL_STEPS);
    const opts = options(model);
    const result = await synthesizeProfile(opts);
    expect(model.doGenerateCalls).toHaveLength(5);
    expect(opts.budget).toHaveBeenCalledTimes(5);
    expect(new Set(opts.budget.mock.results.map((result) => result.value)).size).toBe(5);
    expect([0, 1, 2, 3, 4].map((index) => payload(model, index).files)).toEqual([
      ['environments.yaml'], ['auth.yaml'], ['api-catalog.yaml', 'pages.yaml'], ['data-model.yaml', 'fixtures.yaml'], ['guardrails.yaml'],
    ]);
    expect([0, 1, 2, 3, 4].map((index) => payload(model, index).facts.map((fact: DiscoveryFact) => fact.kind))).toEqual([
      ['port'], ['api'], ['api'], [], [],
    ]);
    expect(payload(model, 1).context['environments.yaml']).toEqual(FILES['environments.yaml']);
    expect(payload(model, 4).context).toEqual(pick('environments.yaml', 'auth.yaml', 'api-catalog.yaml', 'pages.yaml', 'data-model.yaml', 'fixtures.yaml'));
    expect(result.generated).toEqual({ ...FILES, 'guardrails.yaml': { allowedHosts: ['localhost:3000'], forbidden: [], redactFields: [] } });
    expect(result).toMatchObject({ crossCheck: [], interrupted: false });
    expect(Object.keys(result).sort()).toEqual(['crossCheck', 'generated', 'interrupted', 'steps']);
    expect(result.steps.every((step) => step.status === 'generated')).toBe(true);
    for (const call of model.doGenerateCalls) expect(call.tools?.map((tool) => tool.name).sort()).toEqual(['finish', 'report_blocked']);
  });

  it('已确认文件跳过生成，作为后续上下文且不修改输入', async () => {
    const model = scriptedModel(ALL_STEPS.slice(1));
    const existing = { 'environments.yaml': FILES['environments.yaml'] };
    const before = structuredClone({ facts, existing });
    const result = await synthesizeProfile(options(model, existing));
    expect(model.doGenerateCalls).toHaveLength(4);
    expect(result.steps[0]).toEqual({ files: ['environments.yaml'], status: 'skipped' });
    expect(result.generated['environments.yaml']).toBeUndefined();
    expect(payload(model, 0).context['environments.yaml']).toEqual(FILES['environments.yaml']);
    expect({ facts, existing }).toEqual(before);
    expect(result.crossCheck).toEqual([]);
  });

  it('多文件步骤只生成未确认文件，并拒绝夹带已确认文件的输出', async () => {
    const invalid = finish(pick('api-catalog.yaml', 'pages.yaml'));
    const model = scriptedModel([ALL_STEPS[0]!, ALL_STEPS[1]!, invalid, finish(pick('pages.yaml')), ALL_STEPS[3]!, ALL_STEPS[4]!]);
    const result = await synthesizeProfile(options(model, { 'api-catalog.yaml': FILES['api-catalog.yaml'] }));
    expect(payload(model, 2).files).toEqual(['pages.yaml']);
    expect(payload(model, 2).context['api-catalog.yaml']).toEqual(FILES['api-catalog.yaml']);
    expect(model.doGenerateCalls).toHaveLength(6);
    expect(result.generated['api-catalog.yaml']).toBeUndefined();
    expect(result.generated['pages.yaml']).toEqual(FILES['pages.yaml']);
    expect(result.crossCheck).toEqual([]);
  });

  it('单步输出失败后继续后续步骤，并报告缺失文件', async () => {
    const bad: ScriptStep = { text: '不调用工具' };
    const model = scriptedModel([ALL_STEPS[0]!, bad, bad, bad, ...ALL_STEPS.slice(2)]);
    const result = await synthesizeProfile(options(model));
    expect(result.steps[1]).toMatchObject({ files: ['auth.yaml'], status: 'failed', detail: expect.stringContaining('invalid-output') });
    expect(result.generated['auth.yaml']).toBeUndefined();
    expect(result.generated['guardrails.yaml']).toBeDefined();
    expect(result.crossCheck).toEqual(['缺少 auth.yaml']);
    expect(result.interrupted).toBe(false);
  });

  it('多文件步骤任一文件不合法时整步失败，不将半份结果放入上下文', async () => {
    const bad = finish({ ...pick('api-catalog.yaml'), 'pages.yaml': { version: 2, pages: {} } });
    const model = scriptedModel([...ALL_STEPS.slice(0, 2), bad, bad, bad, ...ALL_STEPS.slice(3)]);
    const result = await synthesizeProfile(options(model));
    expect(result.steps[2]).toMatchObject({ files: ['api-catalog.yaml', 'pages.yaml'], status: 'failed' });
    expect(payload(model, 5).context).toEqual(pick('environments.yaml', 'auth.yaml'));
    expect(result.crossCheck).toEqual(['缺少 api-catalog.yaml', '缺少 pages.yaml']);
    expect(result.generated['api-catalog.yaml']).toBeUndefined();
    expect(result.generated['pages.yaml']).toBeUndefined();
  });

  it.each([
    ['reported', { toolCalls: [{ name: 'report_blocked', input: { reason: '无法确定登录方式' } }] }],
    ['model-error', { error: new Error('模型不可用') }],
  ] satisfies [string, ScriptStep][])('%s 失败不影响后续步骤', async (reason, failure) => {
    const model = scriptedModel([ALL_STEPS[0]!, failure, ...ALL_STEPS.slice(2)]);
    const result = await synthesizeProfile(options(model));
    expect(result.steps[1]).toMatchObject({ status: 'failed', detail: expect.stringContaining(reason) });
    expect(result.generated['guardrails.yaml']).toBeDefined();
    expect(result.crossCheck).toEqual(['缺少 auth.yaml']);
  });

  it('预算耗尽仅使当前步骤失败，下一步使用新预算', async () => {
    const model = scriptedModel(ALL_STEPS.slice(1));
    const opts = options(model);
    opts.budget.mockImplementationOnce(() => new BudgetTracker({ steps: 0, tokens: 100000, minutes: 1 }));
    const result = await synthesizeProfile(opts);
    expect(model.doGenerateCalls).toHaveLength(4);
    expect(result.steps[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('budget') });
    expect(result.generated['guardrails.yaml']).toBeDefined();
    expect(result.crossCheck).toEqual(['缺少 environments.yaml']);
  });

  it('全部生成但交叉引用不一致时报告问题', async () => {
    const env = { version: 1, environments: { local: { ...FILES['environments.yaml'].environments.local, reset: 'reset' } } };
    const model = scriptedModel([finish({ 'environments.yaml': env }), ...ALL_STEPS.slice(1)]);
    const result = await synthesizeProfile(options(model));
    expect(result.crossCheck.join('\n')).toContain('reset fixture 不存在');
    expect(Object.keys(result.generated)).toHaveLength(7);
  });

  it('全部已确认时不调用模型、不创建预算，仍检查交叉引用', async () => {
    const model = scriptedModel([]);
    const opts = options(model, { ...FILES, 'fixtures.yaml': { version: 1, fixtures: { reset: { kind: 'http', operation: 'missing' } } } });
    const result = await synthesizeProfile(opts);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(opts.budget).not.toHaveBeenCalled();
    expect(result.generated).toEqual({});
    expect(result.steps).toHaveLength(5);
    expect(result.steps.every((step) => step.status === 'skipped')).toBe(true);
    expect(result.crossCheck.join('\n')).toContain('API 操作不存在');
  });

  it('开始前中断时不调用模型、不创建预算，并报告所有未生成文件', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = scriptedModel([]);
    const opts = options(model);
    const result = await synthesizeProfile({ ...opts, signal: controller.signal });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(opts.budget).not.toHaveBeenCalled();
    expect(result.interrupted).toBe(true);
    expect(result.steps).toHaveLength(5);
    expect(result.steps.every((step) => step.status === 'failed' && step.detail?.includes('interrupted'))).toBe(true);
    expect(result.crossCheck).toEqual([
      '缺少 environments.yaml', '缺少 auth.yaml', '缺少 api-catalog.yaml', '缺少 pages.yaml', '缺少 data-model.yaml', '缺少 fixtures.yaml', '缺少 guardrails.yaml',
    ]);
  });

  it('全部已确认且预先中断时仍返回中断状态，文件保持跳过', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = scriptedModel([]);
    const opts = options(model, FILES);
    const result = await synthesizeProfile({ ...opts, signal: controller.signal });
    expect(result.interrupted).toBe(true);
    expect(result.generated).toEqual({});
    expect(result.crossCheck).toEqual([]);
    expect(result.steps.every((step) => step.status === 'skipped')).toBe(true);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(opts.budget).not.toHaveBeenCalled();
  });

  it('执行中中断保留已有草稿且停止后续模型调用', async () => {
    const controller = new AbortController();
    const model = scriptedModel([ALL_STEPS[0]!, { hang: true }]);
    const opts = options(model);
    const running = synthesizeProfile({ ...opts, signal: controller.signal });
    try {
      await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(2));
    } finally {
      controller.abort();
    }
    const result = await running;
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(opts.budget).toHaveBeenCalledTimes(2);
    expect(result.generated).toEqual(pick('environments.yaml'));
    expect(result.interrupted).toBe(true);
    expect(result.steps.slice(1).every((step) => step.status === 'failed' && step.detail?.includes('interrupted'))).toBe(true);
  });

  it('模型列表为空时在创建预算前拒绝', async () => {
    const opts = options(scriptedModel([]));
    await expect(synthesizeProfile({ ...opts, models: [] })).rejects.toThrow('模型列表不能为空');
    expect(opts.budget).not.toHaveBeenCalled();
  });
});
