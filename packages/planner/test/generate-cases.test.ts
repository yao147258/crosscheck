import { describe, expect, it } from 'vitest';
import { Approvals, BudgetTracker, ClauseSchema, EVIDENCE_TYPES, PROFILE_FILES, ProfileSchema, TestCaseSchema, type TestCase } from '@crosscheck/core';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import { casesForPlan, generateCases } from '../src/index';

const clause = ClauseSchema.parse({ id: 'M-AC-1', text: '用户可以下单', source: { file: 'r.md', line: 1, excerpt: '用户可以下单' } });
const profile = ProfileSchema.parse({
  'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:3000', healthcheck: 'http://localhost:3000/health', reset: 'reset' } } },
  'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } },
  'api-catalog.yaml': { version: 1, operations: {} },
  'pages.yaml': { version: 1, pages: {} },
  'data-model.yaml': { version: 1, queries: {} },
  'fixtures.yaml': { version: 1, fixtures: { reset: { kind: 'command', command: { program: 'node', argv: ['reset.js'] } } } },
  'guardrails.yaml': { allowedHosts: ['localhost:3000'] },
});
const good = { id: 'M-TC-1', covers: ['M-AC-1'], fixtures: ['reset'], actor: 'guest', steps: ['下单'], expectations: [{ id: 'E1', text: '返回订单号', evidence: ['network'] }] };
const finish = (input: unknown): ScriptStep => ({ toolCalls: [{ name: 'finish', input }] });

function setup(steps: ScriptStep[], knownCases: TestCase[] = []) {
  const model = scriptedModel(steps);
  const approvals = Approvals.empty();
  approvals.approve('clause', clause.id, clause, 'u');
  for (const name of PROFILE_FILES) approvals.approve('profile', name, profile[name], 'u');
  for (const tc of knownCases) approvals.approveCase(tc, [clause], 'u');
  return {
    model,
    options: {
      module: 'M', clauses: [clause], approvals, profile, knownCases,
      models: [{ ref: 'mock:planner', model }],
      budget: new BudgetTracker({ steps: 10, tokens: 100000, minutes: 1 }),
      resilience: { retries: 0, sleep: async () => {} },
    },
  };
}

describe('generateCases', () => {
  it('只授予只读检索工具，传入条款原文和合法名称并返回草稿，不修改输入或确认', async () => {
    const { model, options } = setup([finish([good])]);
    const before = JSON.stringify({ clauses: options.clauses, profile, knownCases: options.knownCases });
    const clauseRecord = { ...options.approvals.record('clause', clause.id) };
    const result = await generateCases(options);
    expect(result).toMatchObject({ status: 'done', output: [good], steps: 1 });
    expect((model.doGenerateCalls[0]?.tools ?? []).map((t) => t.name).sort())
      .toEqual(['finish', 'profile_search', 'report_blocked', 'requirements_search']);
    const user = model.doGenerateCalls[0]?.prompt.find((message) => message.role === 'user');
    const text = user?.content.find((part) => part.type === 'text');
    expect(JSON.parse(text?.text ?? 'null')).toEqual({
      module: 'M', clauses: [{ id: clause.id, text: clause.text, source: clause.source }],
      knownCases: [], actors: ['guest'], fixtures: ['reset'], evidenceTypes: [...EVIDENCE_TYPES],
    });
    expect(options.approvals.record('case', good.id)).toBeUndefined();
    expect(options.approvals.record('clause', clause.id)).toEqual(clauseRecord);
    expect(JSON.stringify({ clauses: options.clauses, profile, knownCases: options.knownCases })).toBe(before);
  });

  it('能检索画像与已确认条款且不向模型暴露夹具命令', async () => {
    const { model, options } = setup([
      { toolCalls: [{ name: 'profile_search', input: { type: 'actor', keyword: 'guest' } }, { name: 'requirements_search', input: { ids: ['M-AC-1'] } }] },
      finish([good]),
    ]);
    expect(await generateCases(options)).toMatchObject({ status: 'done', steps: 2 });
    const prompt = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(prompt).toContain('角色认证类型');
    expect(prompt).toContain('用户可以下单');
    expect(prompt).toContain('r.md');
    expect(prompt).not.toContain('reset.js');
  });

  it.each([
    [{ ...good, covers: ['M-AC-9'] }, '覆盖的条款不在可用条款中：M-AC-9'],
    [{ ...good, actor: 'admin' }, 'actor 未在 auth.yaml 中登记：admin'],
    [{ ...good, fixtures: ['seed'] }, '夹具未在 fixtures.yaml 中登记：seed'],
    [{ ...good, id: 'N-TC-1' }, '用例 ID 不属于指定模块'],
  ])('越界输出被反馈后可修正 %#', async (bad, message) => {
    const { model, options } = setup([finish([bad]), finish([good])]);
    expect(await generateCases(options)).toMatchObject({ status: 'done', steps: 2, output: [good] });
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(message);
  });

  it('与已确认用例 ID 冲突时反馈，已确认用例原样提供且不被改写', async () => {
    const known = TestCaseSchema.parse(good);
    const before = structuredClone(known);
    const { model, options } = setup([finish([good]), finish([{ ...good, id: 'M-TC-2' }])], [known]);
    const record = { ...options.approvals.record('case', known.id) };
    expect(await generateCases(options)).toMatchObject({ status: 'done', output: [{ id: 'M-TC-2' }] });
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('用例 ID 与已确认用例冲突');
    const user = model.doGenerateCalls[0]?.prompt.find((message) => message.role === 'user');
    const text = user?.content.find((part) => part.type === 'text');
    expect(JSON.parse(text?.text ?? 'null').knownCases).toEqual([before]);
    expect(options.knownCases).toEqual([before]);
    expect(options.approvals.record('case', known.id)).toEqual(record);
    expect(options.approvals.record('case', 'M-TC-2')).toBeUndefined();
  });

  it('一批草稿中的用例 ID 重复会被反馈', async () => {
    const { model, options } = setup([finish([good, good]), finish([good])]);
    expect(await generateCases(options)).toMatchObject({ status: 'done', steps: 2 });
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('用例 ID 重复');
  });

  it.each([
    { ...good, id: 'M-TC-x' },
    { ...good, covers: [] },
    { ...good, steps: [] },
    { ...good, expectations: [{ id: 'E1', text: '返回订单号', evidence: ['source'] }] },
    { ...good, expectations: [{ id: 'E1', text: '返回订单号', evidence: [] }] },
    { ...good, expectations: [...good.expectations, ...good.expectations] },
  ])('保留 core 结构与证据校验 %#', async (bad) => {
    const { options } = setup([finish([bad]), finish([good])]);
    expect(await generateCases(options)).toMatchObject({ status: 'done', steps: 2, output: [good] });
  });

  it('连续三次非法输出后停止，不能返回越界草稿', async () => {
    const bad = finish([{ ...good, actor: 'admin' }]);
    const { model, options } = setup([bad, bad, bad, finish([good])]);
    expect(await generateCases(options)).toMatchObject({ status: 'blocked', reason: 'invalid-output', steps: 3 });
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it('源码与网络工具即使被模型请求也不会执行', async () => {
    const { model, options } = setup([
      { toolCalls: [{ name: 'read_file', input: { path: 'src/index.ts' } }, { name: 'http', input: { url: 'https://example.com' } }] },
      finish([good]),
    ]);
    expect(await generateCases(options)).toMatchObject({ status: 'done', steps: 2 });
    const prompt = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(prompt).toContain('read_file 在 plan 阶段未授予');
    expect(prompt).toContain('http 在 plan 阶段未授予');
  });

  it('模型上报障碍时原样返回 blocked', async () => {
    const { options } = setup([{ toolCalls: [{ name: 'report_blocked', input: { reason: '缺少操作知识' } }] }]);
    expect(await generateCases(options)).toMatchObject({ status: 'blocked', reason: 'reported', detail: '缺少操作知识' });
  });

  it('透传预算并在耗尽时停止', async () => {
    const { options } = setup([finish([good])]);
    options.budget = new BudgetTracker({ steps: 10, tokens: 10, minutes: 1 });
    expect(await generateCases(options)).toMatchObject({ status: 'blocked', reason: 'budget' });
  });

  it('预先取消时不读取输入或调用模型', async () => {
    const { model, options } = setup([]);
    const controller = new AbortController();
    controller.abort();
    expect(await generateCases({
      ...options, signal: controller.signal,
      get clauses(): typeof options.clauses { throw new Error('不应读取条款'); },
    })).toEqual({
      status: 'blocked', reason: 'interrupted', detail: '执行被中断',
      steps: 0, attempts: 0, modelAttempts: [], retried: false, messages: [],
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('非法模块、空条款和空模型在调用前拒绝', async () => {
    const { model, options } = setup([]);
    await expect(generateCases({ ...options, module: 'bad-module' })).rejects.toThrow('模块名不合法');
    await expect(generateCases({ ...options, clauses: [] })).rejects.toThrow('没有可用于生成用例的已确认条款');
    await expect(generateCases({ ...options, models: [] })).rejects.toThrow('模型列表不能为空');
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it.each(['none', 'stale', 'unclear', 'removed'] as const)('拒绝 %s 条款，避免通过初始提示和 covers 绕过只读工具门禁', async (state) => {
    const { model, options } = setup([]);
    const unavailable = ClauseSchema.parse({ ...clause, id: 'M-AC-2', text: '不可用条款', status: state === 'unclear' || state === 'removed' ? state : 'active' });
    if (state !== 'none') options.approvals.approve('clause', unavailable.id, unavailable, 'u');
    if (state === 'stale') unavailable.text = '修改后的条款';
    await expect(generateCases({ ...options, clauses: [clause, unavailable] })).rejects.toThrow('条款不可用于生成用例');
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('拒绝跨模块或重复 ID 的输入条款', async () => {
    const { model, options } = setup([]);
    const foreign = ClauseSchema.parse({ ...clause, id: 'N-AC-1' });
    options.approvals.approve('clause', foreign.id, foreign, 'u');
    await expect(generateCases({ ...options, clauses: [foreign] })).rejects.toThrow('条款 ID 不属于指定模块');
    await expect(generateCases({ ...options, clauses: [clause, clause] })).rejects.toThrow('id 重复');
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it.each(['none', 'stale'] as const)('拒绝 %s 的画像确认', async (state) => {
    const { model, options } = setup([]);
    if (state === 'none') options.approvals.revoke('profile', 'auth.yaml');
    else options.approvals.approve('profile', 'auth.yaml', { version: 1, actors: {} }, 'u');
    await expect(generateCases(options)).rejects.toThrow('系统画像尚未全部确认');
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

describe('casesForPlan', () => {
  it('直接调用导出的宿主 schema 也校验模块、重复、已知 ID、covers、actor 和 fixtures，并标注路径', () => {
    const schema = casesForPlan('M', [clause], profile, [TestCaseSchema.parse(good)]);
    const result = schema.safeParse([
      { ...good, id: 'N-TC-1', covers: ['M-AC-9'], actor: 'admin', fixtures: ['seed'] },
      { ...good, id: 'N-TC-1' },
      good,
    ]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: [0, 'id'], message: '用例 ID 不属于指定模块' }),
      expect.objectContaining({ path: [0, 'covers', 0], message: '覆盖的条款不在可用条款中：M-AC-9' }),
      expect.objectContaining({ path: [0, 'actor'], message: 'actor 未在 auth.yaml 中登记：admin' }),
      expect.objectContaining({ path: [0, 'fixtures', 0], message: '夹具未在 fixtures.yaml 中登记：seed' }),
      expect.objectContaining({ path: [1, 'id'], message: '用例 ID 重复' }),
      expect.objectContaining({ path: [2, 'id'], message: '用例 ID 与已确认用例冲突' }),
    ]));
  });
});
