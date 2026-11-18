import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '../src/index';

const clause = core.ClauseSchema.parse({ id: 'M-AC-1', text: '原条款', source: { file: '需求.md', line: 1, excerpt: '' } });
const tc = core.TestCaseSchema.parse({ id: 'M-TC-1', covers: [clause.id], actor: 'guest', steps: ['打开页面'], expectations: [{ id: 'E1', text: '可见', evidence: ['dom'] }] });
const models = { extractor: 'test:a', planner: 'test:b', executor: 'test:c', reviewer: 'test:d' };
const userConfig = core.UserModelConfigSchema.parse({ models });
const loadInputs = (store: core.ArtifactStore, options?: core.RunInputOptions) => core.loadVerifiedRunInputs(store, options, userConfig);
const files = () => ({
  'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:3000', healthcheck: 'http://localhost:3000/health', reset: null } } },
  'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } },
  'api-catalog.yaml': { version: 1, operations: {} },
  'pages.yaml': { version: 1, pages: {} },
  'data-model.yaml': { version: 1, queries: {} },
  'fixtures.yaml': { version: 1, fixtures: {} },
  'guardrails.yaml': { allowedHosts: ['localhost:3000'] },
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crosscheck-contract-'));
  roots.push(root);
  const store = new core.ArtifactStore(root);
  await store.writeYaml('config.yaml', { models, defaultEnvironment: 'local' });
  for (const [name, value] of Object.entries(files())) await store.writeYaml(`system/${name}`, value);
  await store.saveClauses('M', [clause]);
  await store.saveCases('M', [tc]);
  const approvals = core.Approvals.empty();
  const profile = await core.loadProfile(store);
  for (const [name, value] of Object.entries(profile)) approvals.approve('profile', name, value, '人工');
  approvals.approve('clause', clause.id, clause, '人工');
  await approvals.save(store);
  return { store, approvals, profile };
}

describe('依赖绑定确认', () => {
  it('旧的用例自身哈希确认不能执行', () => {
    const approvals = core.Approvals.empty();
    approvals.approve('clause', clause.id, clause, '人工');
    approvals.approve('case', tc.id, tc, '人工');
    expect(core.selectExecutableCases([tc], [clause], approvals).ready).toEqual([]);
  });
  it('条款修改并重新确认后，用例仍须重新人工确认', () => {
    const approvals = core.Approvals.empty();
    approvals.approve('clause', clause.id, clause, '人工');
    approvals.approveCase(tc, [clause], '人工');
    expect(core.selectExecutableCases([tc], [clause], approvals).ready).toEqual([tc]);
    const changed = { ...clause, text: '新条款' };
    approvals.approve('clause', changed.id, changed, '人工');
    expect(core.selectExecutableCases([tc], [changed], approvals).ready).toEqual([]);
    expect(approvals.stateCase(tc, [changed])).toBe('stale');
    approvals.approveCase(tc, [changed], '人工');
    expect(core.selectExecutableCases([tc], [changed], approvals).ready).toEqual([tc]);
  });
  it('空画像清单不能绕过门禁', () => {
    expect(() => core.assertProfileApproved({}, core.Approvals.empty())).toThrow(core.GateError);
  });
});

describe('画像与运行输入', () => {
  it('固定读取全部七文件，缺文件拒绝', async () => {
    const { store } = await setup();
    await rm(store.resolve('system/pages.yaml'));
    await expect(core.loadProfile(store)).rejects.toThrow('pages.yaml');
  });
  it('短密钥与普通业务文本部分重合不会阻止运行输入', async () => {
    const { store } = await setup();
    const config = core.UserModelConfigSchema.parse({ models, providers: { test: { type: 'ollama', apiKey: 'a' } } });
    expect((await core.loadVerifiedRunInputs(store, {}, config)).fingerprint).toMatch(/^sha256:/);
  });
  it('项目输入包含全局密钥时拒绝计算指纹', async () => {
    const { store } = await setup();
    await store.saveClauses('M', [{ ...clause, text: '泄漏 KEY_SENTINEL_94827' }]);
    const secretConfig = core.UserModelConfigSchema.parse({ models, providers: { test: { type: 'ollama', apiKey: 'KEY_SENTINEL_94827' } } });
    await expect(core.loadVerifiedRunInputs(store, {}, secretConfig)).rejects.toThrow(/密钥/);
  });
  it('未确认用例保留 BLOCKED，普通缺失 fixture 留待准备', async () => {
    const { store } = await setup();
    await store.saveCases('M', [{ ...tc, fixtures: ['现场造数'] }]);
    const input = await loadInputs(store);
    expect(input.selection.ready).toEqual([]);
    expect(input.selection.blocked).toEqual([{ id: tc.id, reason: '未确认' }]);
    expect(input.missingFixtures).toEqual(['现场造数']);
    expect(input.cases.map((item) => item.id)).toEqual([tc.id]);
    expect(input.environment).toBe('local');
    expect(input.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  it('确认保存加载后可执行，输入指纹绑定条款修改与确认状态', async () => {
    const { store, approvals } = await setup();
    approvals.approveCase(tc, [clause], '人工');
    await approvals.save(store);
    const first = await loadInputs(store);
    expect(first.selection.ready).toEqual([tc]);
    expect(first.approvals.cases[tc.id]).toBe('approved');
    expect((await loadInputs(store)).fingerprint).toBe(first.fingerprint);
    const changed = { ...clause, text: '修改条款并重新确认' };
    await store.saveClauses('M', [changed]);
    approvals.approve('clause', changed.id, changed, '人工');
    await approvals.save(store);
    const next = await loadInputs(store);
    expect(next.selection.ready).toEqual([]);
    expect(next.selection.blocked[0]?.id).toBe(tc.id);
    expect(next.approvals.cases[tc.id]).toBe('stale');
    expect(next.fingerprint).not.toBe(first.fingerprint);
  });
  it('显式空筛选不选用例，全部无功能画像可显式为空但环境仍需明确', async () => {
    const { store, profile } = await setup();
    expect((await loadInputs(store, { caseIds: [] })).cases).toEqual([]);
    expect((await loadInputs(store, { modules: [] })).cases).toEqual([]);
    expect(core.ProfileSchema.safeParse({ ...profile, 'environments.yaml': { version: 1, environments: {} }, 'auth.yaml': { version: 1, actors: {} } }).success).toBe(true);
    await store.writeYaml('config.yaml', { models });
    await expect(loadInputs(store)).rejects.toThrow('环境');
  });
  it('未确认全局画像时拒绝，即使用例过滤为空', async () => {
    const { store, approvals } = await setup();
    approvals.revoke('profile', 'auth.yaml');
    await approvals.save(store);
    await expect(loadInputs(store, { caseIds: [] })).rejects.toThrow(core.GateError);
  });
  it('拒绝缺 actor、未知筛选和不存在默认环境', async () => {
    const { store } = await setup();
    await store.saveCases('M', [{ ...tc, actor: 'missing' }]);
    await expect(loadInputs(store)).rejects.toThrow(/actor|角色/);
    await store.saveCases('M', [tc]);
    await expect(loadInputs(store, { modules: ['missing'] })).rejects.toThrow('模块');
    await expect(loadInputs(store, { caseIds: ['M-TC-9'] })).rejects.toThrow('用例');
    await expect(loadInputs(store, { environment: 'missing' })).rejects.toThrow('环境');
    await store.writeYaml('config.yaml', { models, defaultEnvironment: 'missing' });
    await expect(loadInputs(store)).rejects.toThrow('环境');
  });
  it('跨模块重复 ID 即使过滤也拒绝', async () => {
    const { store } = await setup();
    await store.saveClauses('N', [clause]);
    await expect(loadInputs(store, { modules: ['M'] })).rejects.toThrow('条款');
    await store.saveClauses('N', []);
    await store.saveCases('N', [tc]);
    await expect(loadInputs(store, { modules: ['M'] })).rejects.toThrow('用例');
  });
  it('拒绝非法 auth 密钥字段、环境引用、reset 和 SQL 查询引用', async () => {
    const { store } = await setup();
    await store.writeYaml('system/auth.yaml', { version: 1, actors: { guest: { kind: 'token', env: 'TOKEN', inject: { kind: 'header', name: 'Authorization' }, secret: '不能存储' } } });
    await expect(core.loadProfile(store)).rejects.toThrow();
    await store.writeYaml('system/auth.yaml', { version: 1, actors: { guest: { kind: 'form', environment: 'missing', actions: [] } } });
    await expect(core.loadProfile(store)).rejects.toThrow();
    await store.writeYaml('system/auth.yaml', files()['auth.yaml']);
    await store.writeYaml('system/environments.yaml', { version: 1, environments: { local: { baseURL: 'http://localhost', healthcheck: 'file:///x', reset: null } } });
    await expect(core.loadProfile(store)).rejects.toThrow();
    await store.writeYaml('system/environments.yaml', { version: 1, environments: { local: { baseURL: 'http://localhost', healthcheck: 'http://localhost/health', reset: 'missing' } } });
    await expect(core.loadProfile(store)).rejects.toThrow('reset');
    await store.writeYaml('system/environments.yaml', files()['environments.yaml']);
    await store.writeYaml('system/fixtures.yaml', { version: 1, fixtures: { seed: { kind: 'sql', query: 'missing', params: [], connection: { kind: 'postgres', env: 'FIXTURE_DATABASE_URL' } } } });
    await expect(core.loadProfile(store)).rejects.toThrow('查询');
  });
});

describe('运行数据 schema', () => {
  const time = '2026-11-13T00:00:00.000Z';
  const evidence = { id: 'ev-1', type: 'dom', runId: 'run-1', caseId: tc.id, attempt: 1, actionId: 'a-1', phase: 'execution', time, mime: 'text/html', path: 'runs/run-1/dom.html', digest: `sha256:${'a'.repeat(64)}`, redacted: true };
  it('证据必须有运行归属，路径必须相对且 ID 不可逃逸', () => {
    expect(core.EvidenceRecordSchema.safeParse(evidence).success).toBe(true);
    expect(core.EvidenceRecordSchema.safeParse({ id: 'ev-1', type: 'dom' }).success).toBe(false);
    for (const value of ['../x', '/x', 'C:\\x', 'a/../x', 'a\\..\\x']) {
      expect(core.EvidenceRecordSchema.safeParse({ ...evidence, path: value }).success).toBe(false);
    }
    expect(core.EvidenceRecordSchema.safeParse({ ...evidence, runId: '../x' }).success).toBe(false);
  });
  it('manifest 和结果使用统一状态，BLOCKED 不能伪装 PASS', () => {
    const manifest = { version: 1, runId: 'run-1', fingerprint: `sha256:${'b'.repeat(64)}`, environment: 'local', selectedCaseIds: [tc.id], status: 'completed', start: time, end: time };
    expect(core.RunManifestSchema.safeParse(manifest).success).toBe(true);
    const budget = { limits: { steps: 60, tokens: 400000, minutes: 10 }, used: { steps: 0, tokens: 0, elapsedMs: 0 }, exhausted: false, reason: null };
    const result = { runId: 'run-1', caseId: tc.id, attempt: 1, start: time, end: time, budget, complete: false, status: 'BLOCKED', expectations: [], usage: { inputTokens: 0, outputTokens: 0, cost: 0, pricingKnown: true }, reliability: { attempts: 0, errors: [] }, suggestions: [], drift: [] };
    expect(core.CaseResultSchema.safeParse(result).success).toBe(true);
    expect(core.CaseResultSchema.safeParse({ ...result, status: 'PASS' }).success).toBe(false);
    expect(core.RunResultSchema.safeParse({ version: 1, manifest, cases: [result], status: 'BLOCKED', usage: result.usage, budget: budget.used }).success).toBe(true);
    expect(core.RunResultSchema.safeParse({ version: 1, manifest, cases: [], status: 'PASS', usage: result.usage, budget: budget.used }).success).toBe(false);
  });
  it('模型图像能力显式按 ref 登记，缺省保守 false', () => {
    const cfg = core.ConfigSchema.parse({ models: { ...models, fallback: { executor: 'test:fallback' } }, capabilities: { 'test:c': { images: true }, 'test:fallback': {} } });
    expect(cfg.capabilities['test:c']?.images).toBe(true);
    expect(cfg.capabilities['test:fallback']?.images).toBe(false);
    expect(core.ConfigSchema.parse({ models }).capabilities).toEqual({});
  });
});
