import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RunStore } from '../src/store/run-store';
import { EvidenceStore, createEvidencePresenter, createEvidenceRedactor } from '@crosscheck/tools';
import { validateJudgements } from '../src/judgement';
import { runCase } from '../src/run-suite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { Approvals, ArtifactStore, ClauseSchema, TestCaseSchema, loadProfile, RunResultSchema } from '@crosscheck/core';
import { scriptedModel } from '../../agent/src/testing/scripted-model';
import { runSuite } from '../src/run-suite';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const clause = ClauseSchema.parse({ id: 'M-AC-1', text: '接口返回真实业务值', source: { file: '需求.md', line: 1, excerpt: '原文' } });
const tc = TestCaseSchema.parse({ id: 'M-TC-1', covers: [clause.id], actor: 'guest', steps: ['检查接口'], expectations: [{ id: 'E1', text: '值为ok', evidence: ['network'] }] });
const finish = (verdict = 'pass', evidenceIds: string[] = [], reasoning = '真实证据') => ({ toolCalls: [{ name: 'finish', input: { judgements: [{ expectationId: 'E1', verdict, evidenceIds, reasoning }] } }] });
async function setup(extra: { evidence?: string; actor?: unknown; approved?: boolean; count?: number; steps?: number; fixtures?: string[]; start?: unknown; stop?: unknown } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task9-')); roots.push(root);
  const artifacts = new ArtifactStore(root);
  await artifacts.writeYaml('config.yaml', { models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r', fallback: { reviewer: 'mock:f' } }, providers: { mock: { type: 'ollama' } }, defaultEnvironment: 'local', budget: { perCase: { steps: extra.steps ?? 20, tokens: 10000, minutes: 1 } } });
  const files = { 'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:39999', healthcheck: 'http://localhost:39999/health', reset: null, ...(extra.start ? { start: extra.start } : {}), ...(extra.stop ? { stop: extra.stop } : {}) } } }, 'auth.yaml': { version: 1, actors: { guest: extra.actor ?? { kind: 'anonymous' } } }, 'api-catalog.yaml': { version: 1, operations: {} }, 'pages.yaml': { version: 1, pages: {} }, 'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: {} }, 'guardrails.yaml': { allowedHosts: ['localhost:39999'] } };
  for (const [name, value] of Object.entries(files)) await artifacts.writeYaml(`system/${name}`, value);
  const cases = Array.from({ length: extra.count ?? 1 }, (_, i) => TestCaseSchema.parse({ ...tc, id: `M-TC-${i + 1}`, fixtures: extra.fixtures ?? [], expectations: [{ ...tc.expectations[0], evidence: [extra.evidence ?? 'network'] }] }));
  await artifacts.saveClauses('M', [clause]); await artifacts.saveCases('M', cases);
  const approvals = Approvals.empty();
  for (const [name, value] of Object.entries(await loadProfile(artifacts))) approvals.approve('profile', name, value, '人工');
  approvals.approve('clause', clause.id, clause, '人工');
  if (extra.approved !== false) for (const c of cases) approvals.approveCase(c, [clause], '人工');
  await approvals.save(artifacts);
  return { artifacts, cases, approvals };
}
function harness(artifacts: ArtifactStore, execVerdict = 'pass', reviewVerdict = 'pass', reviewerErrors = 0) {
  let evidenceIds: string[] = []; const requests: string[] = [];
  const executorScript = scriptedModel([{ toolCalls: [{ name: 'http_request', input: { url: 'http://localhost:39999/value' } }] }]);
  let calls = 0;
  const executor = new MockLanguageModelV4({ doGenerate: async opts => {
    if (calls++ === 0) return executorScript.doGenerate(opts);
    runId ||= (await artifacts.list('runs'))[0]!;
    const raw = await artifacts.readBytes(requestsRunPrefix() + '/evidence/index.json');
    evidenceIds = JSON.parse(raw!.toString()).filter((e: any) => e.phase === 'execution').map((e: any) => e.id);
    return scriptedModel([finish(execVerdict, evidenceIds, 'EXECUTOR_SENTINEL_8291')]).doGenerate(opts);
  } });
  let runId = '';
  function requestsRunPrefix() { return `runs/${runId}/cases/M-TC-1/attempts/1`; }
  const reviewer = new MockLanguageModelV4({ doGenerate: async opts => { if (reviewerErrors-- > 0) throw new Error('暂时失败'); return scriptedModel([finish(reviewVerdict, evidenceIds)]).doGenerate(opts); } });
  const fallback = new MockLanguageModelV4({ doGenerate: async opts => scriptedModel([finish(reviewVerdict, evidenceIds)]).doGenerate(opts) });
  return { executor, reviewer, fallback, requests, options: { artifacts, modelOptions: { factories: { ollama: ({ modelId }: { modelId: string }) => modelId === 'e' ? executor : modelId === 'r' ? reviewer : fallback } }, resilience: { retries: 1, baseDelayMs: 0 }, transport: async (url: string) => { requests.push(url); if (!runId) runId = (await artifacts.list('runs'))[0]!; return new Response(JSON.stringify({ value: 'ok' }), { headers: { 'content-type': 'application/json' } }); } } };
}

describe('Task9真实编排边界', () => {
  it.each([['pass', 'pass', 'PASS', 0], ['fail', 'fail', 'FAIL', 1], ['pass', 'fail', 'DISPUTED', 2], ['unclear', 'pass', 'UNCLEAR', 2]] as const)('自判%s/盲审%s合议为%s', async (a, b, status, code) => {
    const { artifacts } = await setup(); const h = harness(artifacts, a, b);
    const outcome = await runSuite(h.options);
    expect(outcome.exitCode).toBe(code); expect(outcome.result?.status).toBe(status);
    expect(RunResultSchema.safeParse(outcome.result).success).toBe(true);
    expect(outcome.result?.usage).toMatchObject({ inputTokens: 30, outputTokens: 15, pricingKnown: false, cost: null });
    expect(h.requests).toEqual(['http://localhost:39999/health', 'http://localhost:39999/value']);
    expect(JSON.stringify(h.reviewer.doGenerateCalls)).not.toContain('EXECUTOR_SENTINEL_8291');
    expect(JSON.stringify(h.reviewer.doGenerateCalls[0]?.tools)).not.toContain('http_request');
  });
  it.each([{ evidence: 'screenshot' }, { evidence: 'dom' }, { actor: { kind: 'form', environment: 'local', actions: [{ kind: 'goto', url: '/' }] } }, { actor: { kind: 'replay', environment: 'local', actions: [{ kind: 'goto', url: '/' }] } }, { actor: { kind: 'token', env: 'SECRET', inject: { kind: 'storage', storage: 'local', name: 'session' } } }])('浏览器暂缓零副作用%j', async extra => {
    const { artifacts } = await setup(extra); const h = harness(artifacts);
    const r = await runSuite(h.options);
    expect(r.result?.cases[0]).toMatchObject({ status: 'BLOCKED', complete: true, reason: expect.stringContaining('浏览器工具暂缓，计划 2 不支持') });
    expect(h.requests).toEqual([]); expect(h.executor.doGenerateCalls).toHaveLength(0);
  });
  it('未审批画像零网络/模型，未确认用例仍有可见BLOCKED结果', async () => {
    const { artifacts, approvals } = await setup({ approved: false }); const h = harness(artifacts);
    const r = await runSuite(h.options); expect(r.result?.cases).toHaveLength(1); expect(r.result?.cases[0]?.reason).toContain('未确认'); expect(h.requests).toEqual([]);
    approvals.revoke('profile', 'auth.yaml'); await approvals.save(artifacts);
    const rejected = await runSuite(h.options); expect(rejected.exitCode).toBe(2); expect(rejected.result).toBeUndefined(); expect(h.requests).toEqual([]); expect(h.executor.doGenerateCalls).toHaveLength(0);
  });
  it('最后一步finish结束executor但预算耗尽不再review', async () => {
    const { artifacts } = await setup({ steps: 2 }); const h = harness(artifacts);
    const r = await runSuite(h.options);
    expect(r.result?.cases[0]).toMatchObject({ status: 'BLOCKED', complete: true, expectations: [{ executor: { verdict: 'pass' }, reviewer: null }], budget: { exhausted: true } });
    expect(h.reviewer.doGenerateCalls).toHaveLength(0);
  });
  it('review主模型重试和fallback每次provider输入都隔离执行结论', async () => {
    const { artifacts } = await setup(); const h = harness(artifacts, 'pass', 'pass', 10);
    const r = await runSuite(h.options); expect(r.result?.status).toBe('PASS');
    expect(h.reviewer.doGenerateCalls).toHaveLength(2); expect(h.fallback.doGenerateCalls).toHaveLength(1);
    for (const call of [...h.reviewer.doGenerateCalls, ...h.fallback.doGenerateCalls]) { expect(JSON.stringify(call.prompt)).not.toContain('EXECUTOR_SENTINEL_8291'); expect(JSON.stringify(call.prompt)).toContain('原文'); }
    expect(r.result?.cases[0]?.reliability.attempts).toBe(5);
  });
  it('complete业务BLOCKED不重放，输入变更拒绝resume', async () => {
    const { artifacts } = await setup({ evidence: 'dom' }); const h = harness(artifacts);
    const first = await runSuite(h.options); const id = first.result!.manifest.runId;
    const next = await runSuite({ ...h.options, resume: id }); expect(next.result?.cases[0]?.attempt).toBe(1); expect(h.requests).toEqual([]);
    await artifacts.writeYaml('config.yaml', { models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:changed', reviewer: 'mock:r' }, defaultEnvironment: 'local' });
    const changed = await runSuite({ ...h.options, resume: id }); expect(changed.exitCode).toBe(2); expect(changed.error).toContain('指纹');
  });
  it('空选择退出2，严格汇总仍有效', async () => {
    const { artifacts } = await setup(); const h = harness(artifacts);
    const r = await runSuite({ ...h.options, caseIds: [] }); expect(r.exitCode).toBe(2); expect(r.result?.cases).toEqual([]); expect(h.requests).toEqual([]);
  });
});
describe('Task9恢复/证据/资源故障', () => {
  it('DB真实Reader关闭连接后才commit，凭证不进入输入快照', async () => {
    const { artifacts, approvals } = await setup({ evidence: 'db' });
    const db = { version: 1, connection: { kind: 'postgres', env: 'READ_DB' }, queries: { value: { sql: 'SELECT value FROM items', parameters: [] } } };
    await artifacts.writeYaml('system/data-model.yaml', db); approvals.approve('profile', 'data-model.yaml', db, '人工'); await approvals.save(artifacts);
    let closed = false; let runId = ''; const queries: string[] = [];
    const executor = new MockLanguageModelV4({ doGenerate: async opts => {
      const ids = [...new Set([...JSON.stringify(opts.prompt).matchAll(/e-[a-f0-9-]{36}/g)].map(m => m[0]))];
      if (ids.length) expect(closed).toBe(true);
      return scriptedModel([ids.length ? finish('pass', ids) : { toolCalls: [{ name: 'db_query', input: { name: 'value' } }] }]).doGenerate(opts);
    } });
    const factory = () => ({ connect: async () => {}, run: async (sql: string, _values: unknown[], row: (r: Record<string, unknown>) => void) => { queries.push(sql); if (sql.includes('pg_roles')) row({ privileged: false }); else if (sql === 'SELECT value FROM items') row({ value: 'ok' }); }, close: async () => { runId = (await artifacts.list('runs'))[0]!; expect(await artifacts.readBytes(`runs/${runId}/cases/M-TC-1/attempts/1/result.json`)).toBeUndefined(); closed = true; } });
    const r = await runSuite({ artifacts, env: { READ_DB: 'postgres://reader:only-secret@localhost:5432/test?sslmode=disable' }, createConnection: factory, modelOptions: { factories: { ollama: () => executor } }, transport: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
    expect(r.result?.status).toBe('PASS'); expect(closed).toBe(true); expect(queries).toContain('BEGIN READ ONLY'); expect(queries).toContain('ROLLBACK');
    const input = (await artifacts.readBytes(`runs/${runId}/input.json`))!.toString(); expect(input).not.toContain('only-secret');
  });
  it('读取未提交attempt的存储异常退出3且不启动外部动作', async () => {
    const { artifacts } = await setup();
    class BrokenStore extends ArtifactStore { override async list(rel: string) { if (rel.endsWith('/attempts')) throw new Error('读取attempt失败'); return super.list(rel); } }
    const h = harness(new BrokenStore(path.dirname(artifacts.root))); const r = await runSuite(h.options); expect(r.exitCode).toBe(3); expect(h.requests).toEqual([]);
  });
  it('共享token预算在executor合法finish恰好耗尽时不再review', async () => {
    const { artifacts } = await setup(); const config = await artifacts.loadConfig(); config.budget.perCase.tokens = 30; await artifacts.writeYaml('config.yaml', config);
    const h = harness(artifacts); const r = await runSuite(h.options);
    expect(r.result?.cases[0]?.expectations[0]).toMatchObject({ executor: { verdict: 'pass' }, reviewer: null, status: 'BLOCKED' }); expect(h.reviewer.doGenerateCalls).toHaveLength(0); expect(r.result?.budget.tokens).toBe(30);
  });
  it('stop收到独立截止后实际关闭命令，再以3提交不完整结果', async () => {
    const good = { program: process.execPath, argv: ['-e', 'process.stdout.write("{}")'], env: {} };
    const slow = { ...good, argv: ['-e', 'setInterval(()=>{},1000)'] };
    const { artifacts } = await setup({ start: good, stop: slow }); const h = harness(artifacts);
    const r = await runSuite(h.options); expect(r.exitCode).toBe(3); expect(r.result?.cases[0]?.complete).toBe(false); expect(r.result?.cases[0]?.reason).toContain('stop');
  }, 12000);
  it('浏览器blocked在start/reset/fixture前拒绝，批准命令工件也不创建', async () => {
    const command = { program: process.execPath, argv: ['-e', 'process.stdout.write("{}")'], env: {} };
    const { artifacts, approvals } = await setup({ evidence: 'dom', start: command, fixtures: ['known'] });
    const profile = await loadProfile(artifacts); const environments = { ...profile['environments.yaml'], environments: { local: { ...profile['environments.yaml'].environments.local!, reset: 'known' } } };
    const fixtures = { version: 1, fixtures: { known: { kind: 'command', command } } };
    for (const [name, value] of Object.entries({ 'environments.yaml': environments, 'fixtures.yaml': fixtures })) { await artifacts.writeYaml(`system/${name}`, value); approvals.approve('profile', name, value, '人工'); } await approvals.save(artifacts);
    const h = harness(artifacts); const r = await runSuite(h.options); expect(r.result?.status).toBe('BLOCKED'); expect(await artifacts.list(`runs/${r.result!.manifest.runId}/commands`)).toEqual([]); expect(h.requests).toEqual([]); expect(h.executor.doGenerateCalls).toHaveLength(0);
  });
  it('候选重试/fallback策略变化也拒绝resume', async () => {
    const { artifacts } = await setup({ evidence: 'dom' }); const h = harness(artifacts); const r = await runSuite(h.options);
    const changed = await runSuite({ ...h.options, resume: r.result!.manifest.runId, resilience: { retries: 0 } }); expect(changed.exitCode).toBe(2); expect(changed.error).toContain('指纹');
  });
  it('reset→known夹具→auth→execute严格顺序且execute只有本case身份', async () => {
    const { artifacts, approvals } = await setup({ fixtures: ['known'], actor: { kind: 'token', env: 'ACTOR', inject: { kind: 'header', name: 'Authorization' } } });
    const profile = await loadProfile(artifacts);
    const environment = { version: 1, environments: { local: { ...profile['environments.yaml'].environments.local!, reset: 'reset' } } };
    const operation = (p: string) => ({ environment: 'local', method: 'POST', path: p, description: p, sources: [clause.source], knowledge: [] });
    const catalog = { version: 1, operations: { reset: operation('/reset'), known: operation('/known') } };
    const fixtures = { version: 1, fixtures: { reset: { kind: 'http', operation: 'reset', body: {} }, known: { kind: 'http', operation: 'known', body: {} } } };
    for (const [name, value] of Object.entries({ 'environments.yaml': environment, 'api-catalog.yaml': catalog, 'fixtures.yaml': fixtures })) { await artifacts.writeYaml(`system/${name}`, value); approvals.approve('profile', name, value, '人工'); } await approvals.save(artifacts);
    const requests: { url: string; auth: string | null }[] = [];
    const h = harness(artifacts); const r = await runSuite({ ...h.options, env: { ACTOR: 'Bearer private-actor' }, transport: async (url, init) => { requests.push({ url, auth: new Headers(init.headers).get('authorization') }); return new Response('{}', { headers: { 'content-type': 'application/json' } }); } });
    expect(r.result?.status).toBe('PASS'); expect(requests).toEqual([{ url: 'http://localhost:39999/health', auth: null }, { url: 'http://localhost:39999/reset', auth: null }, { url: 'http://localhost:39999/known', auth: null }, { url: 'http://localhost:39999/value', auth: 'Bearer private-actor' }]);
    expect(JSON.stringify(h.reviewer.doGenerateCalls)).not.toContain('/reset'); expect(JSON.stringify(h.reviewer.doGenerateCalls)).not.toContain('/known'); expect(JSON.stringify(h.reviewer.doGenerateCalls)).not.toContain('private-actor');
  });
  it('畸形finish JSON累计三次后executor作废，不能重开额度', async () => {
    const { artifacts } = await setup();
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'tool-call', toolCallId: 'bad-json', toolName: 'finish', input: '{broken' }], finishReason: { unified: 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] }) });
    const reviewer = scriptedModel([finish('unclear', [], '不足')]);
    const r = await runSuite({ artifacts, modelOptions: { factories: { ollama: ({ modelId }) => modelId === 'e' ? model : reviewer } }, transport: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
    expect(model.doGenerateCalls).toHaveLength(3); expect(r.result?.cases[0]?.expectations[0]?.executor).toBeNull(); expect(r.result?.status).toBe('BLOCKED');
  });
  it('DB顶层截断不能充完整集合，即使正文很短且模型反复finish', async () => {
    const { artifacts } = await setup(); const run = await RunStore.create(artifacts, { fingerprint: `sha256:${'a'.repeat(64)}`, environment: 'local', selectedCaseIds: [tc.id] }, {});
    await run.withLock(async () => {
      const store = new EvidenceStore(artifacts, { runId: run.manifest.runId, caseId: tc.id, attempt: 1 }, createEvidenceRedactor());
      const record = await store.saveJson('db', { rows: [], truncated: true }, { actionId: 'a-query', phase: 'execution' });
      const text = (await createEvidencePresenter(store)([record.id], { ref: 'mock:e', signal: new AbortController().signal }))[0]!;
      expect(text.text.length).toBeLessThan(100);
      const result = await validateJudgements({ judgements: [{ expectationId: 'E1', verdict: 'pass', evidenceIds: [record.id], reasoning: '全量为空' }] }, [{ id: 'E1', text: '全量为空', evidence: ['db'] }], [record], store, new Map([[record.id, text]])); expect(result.ok).toBe(false);
    });
  });
  it('审批文件读取发生真实宿主存储异常时退出3而非业务blocked', async () => {
    const { artifacts } = await setup();
    class BrokenStore extends ArtifactStore { override async readBytes(rel: string) { if (rel === 'approvals.json') throw new Error('宿主磁盘失败'); return super.readBytes(rel); } }
    const r = await runSuite({ artifacts: new BrokenStore(path.dirname(artifacts.root)) }); expect(r.exitCode).toBe(3);
  });
  it('中途崩溃残留未提交attempt保留，resume使用新attempt且拒绝展示快照篡改', async () => {
    const { artifacts } = await setup({ evidence: 'dom' }); const h = harness(artifacts); const first = await runSuite(h.options); const id = first.result!.manifest.runId;
    const run = await RunStore.load(artifacts, id);
    await run.withLock(async () => { await artifacts.remove(`runs/${id}/cases/M-TC-1/attempts/1/result.json`); await run.updateStatus('aborted'); });
    const resumed = await runSuite({ ...h.options, resume: id }); expect(resumed.result?.cases[0]?.attempt).toBe(2);
    expect(await artifacts.readBytes(`runs/${id}/cases/M-TC-1/attempts/1/evidence/index.json`)).toBeDefined();
    const raw = JSON.parse((await artifacts.readBytes(`runs/${id}/input.json`))!.toString()); raw.display.environment = '篡改'; await artifacts.writeJson(`runs/${id}/input.json`, raw);
    const tampered = await runSuite({ ...h.options, resume: id }); expect(tampered.exitCode).toBe(2); expect(tampered.error).toContain('指纹');
  });
  it('完成FAIL不重放任何HTTP/夹具/模型', async () => {
    const { artifacts } = await setup(); const h = harness(artifacts, 'fail', 'fail'); const first = await runSuite(h.options);
    const n = h.requests.length, calls = h.executor.doGenerateCalls.length;
    const resumed = await runSuite({ ...h.options, resume: first.result!.manifest.runId }); expect(resumed.exitCode).toBe(1); expect(h.requests).toHaveLength(n); expect(h.executor.doGenerateCalls).toHaveLength(calls);
  });
  it('已知价格按真实模型计费并保留数字预算汇总', async () => {
    const { artifacts } = await setup(); const config = await artifacts.loadConfig(); config.pricing = { 'mock:e': { inputPerMTok: 1, outputPerMTok: 2 }, 'mock:r': { inputPerMTok: 3, outputPerMTok: 4 } }; await artifacts.writeYaml('config.yaml', config);
    const h = harness(artifacts); const r = await runSuite(h.options);
    expect(r.result?.usage).toEqual({ inputTokens: 30, outputTokens: 15, pricingKnown: true, cost: 0.00009 });
    expect(r.result?.budget).toMatchObject({ steps: 3, tokens: 45 });
  });
  it('已批准凭证值即使出现在普通字段也不写input；按引用采集而不枚举全部env', async () => {
    const { artifacts, approvals } = await setup({ actor: { kind: 'token', env: 'AUTH_SECRET', inject: { kind: 'header', name: 'Authorization' } } });
    const changed = { ...clause, notes: 'Bearer literal-secret-829' }; await artifacts.saveClauses('M', [changed]); approvals.approve('clause', changed.id, changed, '人工'); approvals.approveCase(tc, [changed], '人工'); await approvals.save(artifacts);
    const h = harness(artifacts); const r = await runSuite({ ...h.options, env: { AUTH_SECRET: 'Bearer literal-secret-829' } });
    const raw = (await artifacts.readBytes(`runs/${r.result!.manifest.runId}/input.json`))!.toString(); expect(raw).not.toContain('literal-secret-829');
  });
  it('known夹具失败即BLOCKED不进入missing fallback/auth/execution', async () => {
    const { artifacts, approvals, cases } = await setup({ fixtures: ['missing', 'known'] });
    const fixtures = { version: 1, fixtures: { known: { kind: 'command', command: { program: process.execPath, argv: ['-e', 'process.exit(1)'], env: {} } } } };
    await artifacts.writeYaml('system/fixtures.yaml', fixtures); approvals.approve('profile', 'fixtures.yaml', fixtures, '人工'); await approvals.save(artifacts);
    const h = harness(artifacts); const r = await runSuite(h.options);
    expect(r.result?.status).toBe('BLOCKED'); expect(h.executor.doGenerateCalls).toHaveLength(0); expect(h.reviewer.doGenerateCalls).toHaveLength(0); expect(h.requests).toHaveLength(1);
  });
  it('只有missing普通夹具才prepare现场HTTP造数且execute不获fixture/command工具', async () => {
    const { artifacts } = await setup({ fixtures: ['missing'] });
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async opts => {
      calls++;
      const ids = [...new Set([...JSON.stringify(opts.prompt).matchAll(/e-[a-f0-9-]{36}/g)].map(match => match[0]))];
      const step = calls === 1 ? { toolCalls: [{ name: 'http_request', input: { url: 'http://localhost:39999/seed', method: 'POST', headers: [['content-type', 'application/json']], body: '{}' } }] } : calls === 2 ? { toolCalls: [{ name: 'finish', input: { prepared: true, evidenceIds: ids } }] } : finish('unclear', [], '无业务观察');
      return scriptedModel([step]).doGenerate(opts);
    } });
    const urls: string[] = [];
    const r = await runSuite({ artifacts, modelOptions: { factories: { ollama: () => model } }, transport: async url => { urls.push(url); return new Response('{}', { headers: { 'content-type': 'application/json' } }); } });
    expect(r.result?.status).toBe('UNCLEAR'); expect(urls).toEqual(['http://localhost:39999/health', 'http://localhost:39999/seed']);
    expect(r.result?.cases[0]?.reliability.errors).toContain('fixture-ad-hoc:missing'); expect(r.result?.cases[0]?.suggestions).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[2]?.tools)).not.toMatch(/fixture_execute|program|command/);
    expect(JSON.stringify(model.doGenerateCalls[3]?.prompt)).not.toContain('fixture');
    expect(JSON.stringify(model.doGenerateCalls[3]?.prompt)).not.toContain('/seed');
  });
  it('宿主采证磁盘异常优先退出3且不再调用review，不把工具异常吞为业务PASS', async () => {
    class FailingStore extends ArtifactStore {
      override async writeJson(rel: string, value: unknown) {
        if (rel.includes('/evidence/index.json') && Array.isArray(value) && value.some((r: any) => r.phase === 'execution')) throw new Error('磁盘失败');
        return super.writeJson(rel, value);
      }
    }
    const { artifacts } = await setup(); const failed = new FailingStore(path.dirname(artifacts.root)); const h = harness(failed);
    const r = await runSuite(h.options); expect(r.exitCode).toBe(3); expect(r.result?.status).toBe('BLOCKED'); expect(h.reviewer.doGenerateCalls).toHaveLength(0);
  });
  it('总deadline从健康检查开始贯穿真实transport，时长耗尽不调用模型', async () => {
    const { artifacts } = await setup(); const config = await artifacts.loadConfig(); config.budget.perCase.minutes = 0.0003; await artifacts.writeYaml('config.yaml', config);
    let aborted = false;
    const model = scriptedModel([]);
    const r = await runSuite({ artifacts, modelOptions: { factories: { ollama: () => model } }, transport: async (_url, init) => new Promise((_resolve, reject) => { const signal = init.signal!; const abort = () => { aborted = true; reject(new Error('已取消')); }; if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }) });
    expect(aborted).toBe(true); expect(r.result?.status).toBe('BLOCKED'); expect(r.result?.cases[0]?.budget.exhausted).toBe(true); expect(model.doGenerateCalls).toHaveLength(0);
  });
  it('批准operation的404漂移只记录约定和真实观察证据，仍保留业务FAIL', async () => {
    const { artifacts, approvals } = await setup();
    const catalog = { version: 1, operations: { value: { environment: 'local', method: 'GET', path: '/value', description: '批准的业务接口', knowledge: [], sources: [clause.source] } } };
    await artifacts.writeYaml('system/api-catalog.yaml', catalog); approvals.approve('profile', 'api-catalog.yaml', catalog, '人工'); await approvals.save(artifacts);
    const h = harness(artifacts, 'fail', 'fail'); const r = await runSuite({ ...h.options, transport: async url => new Response('{}', { status: url.endsWith('/health') ? 200 : 404, headers: { 'content-type': 'application/json' } }) });
    expect(r.result?.status).toBe('FAIL'); expect(r.result?.cases[0]?.drift).toHaveLength(1); expect(r.result?.cases[0]?.drift[0]).toContain('value'); expect(r.result?.cases[0]?.drift[0]).toMatch(/e-[a-f0-9-]+/);
  });
  it('没有批准操作对应的404只是业务观察，不自动作为drift掩盖FAIL', async () => {
    const { artifacts } = await setup(); const h = harness(artifacts, 'fail', 'fail');
    const r = await runSuite({ ...h.options, transport: async url => new Response('{"missing":true}', { status: url.endsWith('/health') ? 200 : 404, headers: { 'content-type': 'application/json' } }) });
    expect(r.result?.status).toBe('FAIL'); expect(r.result?.cases[0]?.drift).toEqual([]);
  });
  it('missing现场造数耗尽共享预算时不得再auth，准备凭据不进入review', async () => {
    const { artifacts } = await setup({ fixtures: ['missing'], steps: 1 });
    const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { prepared: true } }] }]);
    const r = await runSuite({ artifacts, modelOptions: { factories: { ollama: () => model } }, transport: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
    expect(r.result?.status).toBe('BLOCKED'); expect(model.doGenerateCalls).toHaveLength(1);
    const prefix = `runs/${r.result!.manifest.runId}/cases/M-TC-1/attempts/1`;
    const index = JSON.parse((await artifacts.readBytes(`${prefix}/evidence/index.json`))!.toString());
    expect(index.filter((e: any) => e.type === 'console')).toEqual([]);
  });
  it('模型实际尝试usage保持数字不被通用redactor改成REDACTED', async () => {
    const { artifacts } = await setup(); const h = harness(artifacts); const r = await runSuite(h.options);
    const log = JSON.parse((await artifacts.readBytes(`runs/${r.result!.manifest.runId}/cases/M-TC-1/attempts/1/models.json`))!.toString());
    expect(log[0].attempts[0]).toMatchObject({ ref: 'mock:e', status: 'success', usage: { inputTokens: 10, outputTokens: 5 } });
  });
  it('input展示快照的URL和已批准env秘密不落盘，源指纹仍可正确resume', async () => {
    const { artifacts, approvals } = await setup({ actor: { kind: 'token', env: 'AUTH_SECRET', inject: { kind: 'header', name: 'Authorization' } } });
    const original = await loadProfile(artifacts);
    const envs = { ...original['environments.yaml'], environments: { local: { ...original['environments.yaml'].environments.local!, healthcheck: 'http://localhost:39999/health?api_key=URL_SECRET_828' } } };
    await artifacts.writeYaml('system/environments.yaml', envs); approvals.approve('profile', 'environments.yaml', envs, '人工'); await approvals.save(artifacts);
    const h = harness(artifacts);
    const r = await runSuite({ ...h.options, env: { AUTH_SECRET: 'Bearer AUTH_SECRET_882' } });
    const raw = (await artifacts.readBytes(`runs/${r.result!.manifest.runId}/input.json`))!.toString();
    expect(raw).not.toContain('URL_SECRET_828'); expect(raw).not.toContain('Bearer AUTH_SECRET_882');
    const resumed = await runSuite({ ...h.options, resume: r.result!.manifest.runId, env: { AUTH_SECRET: 'Bearer CHANGED_SECRET' } }); expect(resumed.exitCode).not.toBe(3);
  });
  it('取消保留全部选中用例且不再启动下一case，resume新attempt后完成不重放', async () => {
    const { artifacts } = await setup({ count: 2 }); const ac = new AbortController(); const urls: string[] = [];
    const first = harness(artifacts);
    const interrupted = await runSuite({ ...first.options, signal: ac.signal, transport: async url => { urls.push(url); ac.abort(); return new Response('{}', { headers: { 'content-type': 'application/json' } }); } });
    expect(interrupted.exitCode).toBe(2); expect(interrupted.interrupted).toBe(true);
    expect(interrupted.result?.cases.map(c => [c.complete, c.status])).toEqual([[false, 'BLOCKED'], [false, 'BLOCKED']]);
    expect(urls).toHaveLength(1); expect(first.executor.doGenerateCalls).toHaveLength(0);
    const id = interrupted.result!.manifest.runId;
    const model = scriptedModel(Array.from({ length: 4 }, () => finish('unclear', [], '观察不足')));
    const resumed = await runSuite({ artifacts, resume: true, resilience: first.options.resilience, modelOptions: { factories: { ollama: () => model } }, transport: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
    expect(resumed.result?.manifest.runId).toBe(id); expect(resumed.result?.cases.map(c => c.attempt)).toEqual([2, 2]); expect(resumed.result?.status).toBe('UNCLEAR');
    const before = model.doGenerateCalls.length;
    await runSuite({ artifacts, resume: id, resilience: first.options.resilience, modelOptions: { factories: { ollama: () => model } } }); expect(model.doGenerateCalls).toHaveLength(before);
    expect(await artifacts.readBytes(`runs/${id}/cases/M-TC-1/attempts/1/result.json`)).toBeDefined();
  });
  it('混合结构/语义错误累计三次，失败方null而非抄reviewer', async () => {
    const { artifacts } = await setup();
    const bad = scriptedModel([{ toolCalls: [{ name: 'finish', input: { judgements: '坏结构' } }] }, finish('pass', ['forged']), { toolCalls: [{ name: 'finish', input: { judgements: [] } }] }, finish('unclear')]);
    const review = scriptedModel([finish('unclear', [], '没有观察')]);
    const r = await runSuite({ artifacts, modelOptions: { factories: { ollama: ({ modelId }) => modelId === 'e' ? bad : review } }, transport: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
    expect(bad.doGenerateCalls).toHaveLength(3); expect(review.doGenerateCalls).toHaveLength(1);
    expect(r.result?.cases[0]?.expectations[0]).toMatchObject({ executor: null, reviewer: { verdict: 'unclear' }, status: 'BLOCKED' });
  });
  it.each(['omitted', 'truncated'] as const)('业务HAR源%s不能靠短文本变成完整证据', async mode => {
    const { artifacts } = await setup(); const h = harness(artifacts);
    const response = mode === 'omitted' ? new Response('raw', { headers: { 'content-type': 'application/octet-stream' } }) : new Response('x'.repeat(17000), { headers: { 'content-type': 'text/plain' } });
    const r = await runSuite({ ...h.options, transport: async url => { const ids = await artifacts.list('runs'); void ids; return url.endsWith('/health') ? new Response('{}', { headers: { 'content-type': 'application/json' } }) : response; } });
    expect(r.result?.status).toBe('BLOCKED');
    expect(r.result?.cases[0]?.expectations[0]?.executor).toBeNull();
  });
  it('单用例仍真实审批，运行期输入变更不改变已固定快照，后续resume拒绝', async () => {
    const { artifacts } = await setup(); let changed = false;
    const model = scriptedModel([finish('unclear', [], '原条款不可判定'), finish('unclear', [], '独立不可判定')]);
    const r = await runCase({ artifacts, caseId: tc.id, modelOptions: { factories: { ollama: () => model } }, transport: async () => { if (!changed) { changed = true; await artifacts.saveClauses('M', [{ ...clause, text: 'MUTATED_MID_RUN' }]); } return new Response('{}', { headers: { 'content-type': 'application/json' } }); } });
    expect(r.result?.status).toBe('UNCLEAR');
    expect(JSON.stringify(model.doGenerateCalls)).not.toContain('MUTATED_MID_RUN');
    const next = await runSuite({ artifacts, resume: r.result!.manifest.runId }); expect(next.exitCode).toBe(2); expect(next.error).toContain('指纹');
  });
  it('健康检查使用RequestPolicy，被禁止时零transport/模型', async () => {
    const { artifacts, approvals } = await setup();
    const guard = { allowedHosts: ['localhost:39999'], forbidden: [{ path: '/health' }], redactFields: [] };
    await artifacts.writeYaml('system/guardrails.yaml', guard); approvals.approve('profile', 'guardrails.yaml', guard, '人工'); await approvals.save(artifacts);
    const h = harness(artifacts); const r = await runSuite(h.options);
    expect(r.result?.status).toBe('BLOCKED'); expect(h.requests).toEqual([]); expect(h.executor.doGenerateCalls).toHaveLength(0);
  });
  it('生命周期持锁直至真实业务采证和case提交，trace脱敏且没有finish伪console', async () => {
    const { artifacts } = await setup(); const h = harness(artifacts); let locked = 0;
    const r = await runSuite({ ...h.options, transport: async (url, init) => { const id = (await artifacts.list('runs'))[0]!; const run = await RunStore.load(artifacts, id); await expect(run.withLock(async () => {})).rejects.toThrow(); locked++; return h.options.transport(url); } });
    expect(r.result?.status).toBe('PASS'); expect(locked).toBe(2);
    const prefix = `runs/${r.result!.manifest.runId}/cases/M-TC-1/attempts/1`;
    const trace = (await artifacts.readBytes(`${prefix}/trace.jsonl`))!.toString();
    expect(trace).toContain('http_request'); expect(trace).toContain('durationMs'); expect(trace).not.toContain('EXECUTOR_SENTINEL');
    const index = JSON.parse((await artifacts.readBytes(`${prefix}/evidence/index.json`))!.toString());
    expect(index.filter((e: any) => e.phase === 'execution').map((e: any) => e.type)).toEqual(['network']);
  });
  it('start成功配对stop一次，取消时stop使用独立signal且实际退出后提交', async () => {
    const command = { program: process.execPath, argv: ['-e', 'process.stdout.write("{}")'], env: {} };
    const { artifacts } = await setup({ start: command, stop: command }); const ac = new AbortController();
    const r = await runSuite({ artifacts, signal: ac.signal, modelOptions: { factories: { ollama: () => scriptedModel([]) } }, transport: async () => { ac.abort(); return new Response('{}', { headers: { 'content-type': 'application/json' } }); } });
    expect(r.exitCode).toBe(2); expect(r.result?.cases[0]?.complete).toBe(false);
    const dirs = await artifacts.list(`runs/${r.result!.manifest.runId}/commands`); expect(dirs).toHaveLength(2);
    const trace = (await artifacts.readBytes(`runs/${r.result!.manifest.runId}/cases/M-TC-1/attempts/1/trace.jsonl`))!.toString(); expect(trace).toContain('environment.stop');
  });
  it('start失败不health/reset，stop失败优先退出3不伪装PASS', async () => {
    const good = { program: process.execPath, argv: ['-e', 'process.stdout.write("{}")'], env: {} };
    const bad = { ...good, argv: ['-e', 'process.exit(1)'] };
    const failedStart = await setup({ start: bad, stop: good }); const h = harness(failedStart.artifacts);
    const a = await runSuite(h.options); expect(a.result?.status).toBe('BLOCKED'); expect(h.requests).toEqual([]); expect(await failedStart.artifacts.list(`runs/${a.result!.manifest.runId}/commands`)).toHaveLength(1);
    const failedStop = await setup({ start: good, stop: bad }); const h2 = harness(failedStop.artifacts);
    const b = await runSuite(h2.options); expect(b.exitCode).toBe(3); expect(b.result?.status).toBe('BLOCKED'); expect(b.result?.cases[0]?.complete).toBe(false);
  });
  it('真实loopback HTTP完整业务观察进入独立review，未知价格null', async () => {
    const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value: 'ok' })); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const port = (server.address() as { port: number }).port; const baseURL = `http://127.0.0.1:${port}`;
      const { artifacts, approvals } = await setup();
      const environments = { version: 1, environments: { local: { baseURL, healthcheck: `${baseURL}/health`, reset: null } } };
      const guards = { allowedHosts: [`127.0.0.1:${port}`], forbidden: [], redactFields: [] };
      await artifacts.writeYaml('system/environments.yaml', environments); await artifacts.writeYaml('system/guardrails.yaml', guards);
      approvals.approve('profile', 'environments.yaml', environments, '人工'); approvals.approve('profile', 'guardrails.yaml', guards, '人工'); await approvals.save(artifacts);
      const model = new MockLanguageModelV4({ doGenerate: async opts => {
        const prompt = JSON.stringify(opts.prompt); const matches = [...prompt.matchAll(/e-[a-f0-9-]{36}/g)]; const ids = [...new Set(matches.map(m => m[0]))];
        return scriptedModel([ids.length ? finish('pass', ids) : { toolCalls: [{ name: 'http_request', input: { url: `${baseURL}/value` } }] }]).doGenerate(opts);
      } });
      const r = await runSuite({ artifacts, modelOptions: { factories: { ollama: () => model } } }); expect(r.result?.status).toBe('PASS'); expect(r.result?.usage.cost).toBeNull();
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
  });
  it('语义校验拒绝缺漏/多余/重复预期，以及unclear引用伪ID、准备凭证和损坏文件', async () => {
    const { artifacts } = await setup();
    const run = await RunStore.create(artifacts, { fingerprint: `sha256:${'a'.repeat(64)}`, environment: 'local', selectedCaseIds: [tc.id] }, {});
    await run.withLock(async () => {
      const store = new EvidenceStore(artifacts, { runId: run.manifest.runId, caseId: tc.id, attempt: 1 }, createEvidenceRedactor());
      const prep = await store.saveText('console', '准备完成', { actionId: 'a-prep', phase: 'preparation' });
      const record = await store.saveJson('db', { rows: [{ value: 'ok' }], truncated: false }, { actionId: 'a-biz', phase: 'execution' });
      const texts = await createEvidencePresenter(store)([record.id, prep.id], { ref: 'mock:a', signal: new AbortController().signal }); const shown = new Map(texts.map(t => [t.id, t]));
      const expectations = [{ id: 'E1', text: 'ok', evidence: ['db' as const] }];
      const j = { expectationId: 'E1', verdict: 'unclear' as const, evidenceIds: [], reasoning: '无法判断' };
      for (const judgements of [[], [j, j], [{ ...j, expectationId: 'E2' }], [{ ...j, evidenceIds: ['forged'] }], [{ ...j, evidenceIds: [prep.id] }]]) expect((await validateJudgements({ judgements }, expectations, [record, prep], store, shown)).ok).toBe(false);
      expect((await validateJudgements({ judgements: [j] }, expectations, [record], store, shown)).ok).toBe(true);
      await artifacts.writeBytes(record.path, Buffer.from('tampered'));
      await expect(validateJudgements({ judgements: [{ ...j, evidenceIds: [record.id] }] }, expectations, [record], store, shown)).rejects.toThrow();
    });
  });
});
describe('Task9 fix1 I-1 展示快照URL语义', () => {
  it.each(['/export?api_key=SNAP_REL_714&mode=safe#token=SNAP_HASH_714&tab=one', 'http://user:SNAP_USER_714@localhost:39999/export?api_key=SNAP_REL_714&mode=safe#token=SNAP_HASH_714&tab=one', '//user:SNAP_USER_714@localhost:39999/export?api_key=SNAP_REL_714&mode=safe#token=SNAP_HASH_714&tab=one'])('明确API/page路径清洗并可resume %s', async pathValue => {
    const { artifacts, approvals } = await setup({ evidence: 'dom' });
    const operation = { environment: 'local', method: 'GET', path: pathValue, description: '自然语言保留：/example?api_key=文档占位符', knowledge: [], sources: [clause.source] };
    const api = { version: 1, operations: { export: operation } };
    const { method: _method, ...page } = operation;
    const pages = { version: 1, pages: { export: page } };
    for (const [name, value] of Object.entries({ 'api-catalog.yaml': api, 'pages.yaml': pages })) { await artifacts.writeYaml(`system/${name}`, value); approvals.approve('profile', name, value, '人工'); }
    await approvals.save(artifacts);
    const h = harness(artifacts); const first = await runSuite(h.options); const id = first.result!.manifest.runId;
    const bytes = (await artifacts.readBytes(`runs/${id}/input.json`))!.toString();
    expect(bytes).not.toMatch(/SNAP_REL_714|SNAP_HASH_714|SNAP_USER_714/);
    const saved = JSON.parse(bytes); const projected = saved.display.profile['api-catalog.yaml'].operations.export;
    expect(projected.path).toContain('/export'); expect(projected.path).toContain('mode=safe'); expect(projected.path).toContain('tab=one'); expect(projected.description).toContain('文档占位符');
    const resumed = await runSuite({ ...h.options, resume: id }); expect(resumed.exitCode).toBe(2); expect(resumed.error).toBeUndefined(); expect(resumed.result?.cases[0]?.attempt).toBe(1);
  });
});
describe('Task9 fix1 I-2 HTTP轨迹投影', () => {
  it.each([true, false])('真实trace拒绝敏感输入=%s，不保存原载荷且安全URL仍保留', async rejected => {
    const { artifacts } = await setup();
    const url = rejected ? 'http://localhost:39999/value?api_key=TRACE_SECRET_714&mode=safe' : 'http://localhost:39999/value?mode=safe';
    const input = { url, ...(rejected ? { method: 'POST', headers: [['content-type', 'text/plain']], body: 'UNVALIDATED_RAW_714' } : {}) };
    const model = scriptedModel([{ toolCalls: [{ name: 'http_request', input }] }, ...Array.from({ length: 6 }, () => finish('unclear', [], '观察不足'))]);
    const urls: string[] = [];
    const r = await runSuite({ artifacts, modelOptions: { factories: { ollama: () => model } }, transport: async url => { urls.push(url); return new Response('{}', { headers: { 'content-type': 'application/json' } }); } });
    const raw = (await artifacts.readBytes(`runs/${r.result!.manifest.runId}/cases/M-TC-1/attempts/1/trace.jsonl`))!.toString();
    expect(raw).not.toMatch(/TRACE_SECRET_714|UNVALIDATED_RAW_714/);
    const http = raw.trim().split('\n').map(line => JSON.parse(line)).find(e => e.action.type === 'http_request');
    expect(http.action.input.value.url).toContain('mode=safe'); expect(http.action.input.value.url).toContain('/value');
    expect(urls).toHaveLength(rejected ? 1 : 2);
    if (rejected) expect(http.action.input.value).toMatchObject({ rejected: true });
  });
  it('command认证前现场准备载荷/轨迹保守省略，不能以省略凭据完成准备', async () => {
    const { artifacts, approvals } = await setup({ fixtures: ['missing'], actor: { kind: 'command', command: { program: process.execPath, argv: ['-e', 'process.stdout.write(JSON.stringify({headers:{Authorization:"Bearer LATE_TRACE_714"}}))'], env: {} } } });
    const model = scriptedModel([{ toolCalls: [{ name: 'http_request', input: { url: 'http://localhost:39999/seed?value=LATE_TRACE_714&mode=safe' } }] }, { toolCalls: [{ name: 'finish', input: { prepared: true } }] }, finish('unclear', [], '不足'), finish('unclear', [], '不足')]);
    const r = await runSuite({ artifacts, modelOptions: { factories: { ollama: () => model } }, transport: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
    const raw = (await artifacts.readBytes(`runs/${r.result!.manifest.runId}/cases/M-TC-1/attempts/1/trace.jsonl`))!.toString(); expect(raw).not.toContain('LATE_TRACE_714'); expect(raw).not.toContain('mode=safe'); expect(raw).toContain('动态身份认证前动作载荷省略'); expect(r.result!.status).toBe('BLOCKED');
  });
});
describe('Task9 fix1 I-3 异常阶段模型审计', () => {
  it.each(['tool', 'presenter', 'semantic'] as const)('primary/retry/fallback后%s异常不丢尝试、tokens或未知费用', async fault => {
    const { artifacts } = await setup();
    const config = await artifacts.loadConfig(); config.models.fallback.executor = 'mock:ef'; config.pricing = { 'mock:e': { inputPerMTok: 1, outputPerMTok: 1 }, 'mock:ef': { inputPerMTok: 1, outputPerMTok: 1 } }; await artifacts.writeYaml('config.yaml', config);
    let fired = false;
    class FaultStore extends ArtifactStore {
      override async writeJson(rel: string, value: unknown) {
        if (fault === 'tool' && !fired && rel.endsWith('/evidence/index.json') && Array.isArray(value) && value.some((r: any) => r.phase === 'execution')) { fired = true; throw new Error('一次磁盘故障'); }
        return super.writeJson(rel, value);
      }
      override async readBytes(rel: string) {
        const bytes = await super.readBytes(rel);
        const candidateReturned = primary.doGenerateCalls.length + h.executor.doGenerateCalls.length;
        if (!fired && rel.includes('/evidence/files/') && bytes?.toString().includes('/value') && (fault === 'presenter' && candidateReturned === 3 || fault === 'semantic' && candidateReturned === 5)) { fired = true; throw new Error('读取业务证据故障'); }
        return bytes;
      }
    }
    const store = new FaultStore(path.dirname(artifacts.root)); const h = harness(store); const primary = scriptedModel(Array.from({ length: 8 }, () => ({ error: new Error('provider瞬时故障') })));
    const r = await runSuite({ ...h.options, modelOptions: { factories: { ollama: ({ modelId }) => modelId === 'e' ? primary : modelId === 'ef' ? h.executor : h.reviewer } } });
    expect(fired).toBe(true); expect(r.exitCode).toBe(3); expect(h.requests.filter(url => url.endsWith('/value'))).toHaveLength(1); expect(h.reviewer.doGenerateCalls).toHaveLength(0);
    const prefix = `runs/${r.result!.manifest.runId}/cases/M-TC-1/attempts/1`;
    const logs = JSON.parse((await store.readBytes(`${prefix}/models.json`))!.toString()); const attempts = logs.flatMap((l: any) => l.attempts);
    expect(attempts.length).toBe(primary.doGenerateCalls.length + h.executor.doGenerateCalls.length); expect(r.result?.cases[0]?.reliability.attempts).toBe(attempts.length);
    expect(attempts.slice(0, 3)).toMatchObject([{ ref: 'mock:e', status: 'error', usage: null }, { ref: 'mock:e', status: 'error', usage: null }, { ref: 'mock:ef', status: 'success', usage: { inputTokens: 10, outputTokens: 5 } }]);
    expect(r.result?.usage).toEqual({ inputTokens: h.executor.doGenerateCalls.length * 10, outputTokens: h.executor.doGenerateCalls.length * 5, pricingKnown: false, cost: null });
  });
});
describe('Task9 fix1 I-4 提交期取消', () => {
  it('原子发布完成后才取消不撤销已提交业务，resume跳过完成case', async () => {
    const { artifacts } = await setup(); const ac = new AbortController(); let published = false;
    class AfterPublishStore extends ArtifactStore {
      override async publishJsonSelected<T>(rel: string, select: () => T): Promise<T> {
        const committed = await super.publishJsonSelected(rel, select);
        if (rel.endsWith('/result.json') && !published) { published = true; ac.abort(); }
        return committed;
      }
    }
    const store = new AfterPublishStore(path.dirname(artifacts.root)); const h = harness(store); const first = await runSuite({ ...h.options, signal: ac.signal });
    expect(first.interrupted).toBe(true); expect(first.result?.cases[0]).toMatchObject({ complete: true, status: 'PASS' });
    const calls = h.executor.doGenerateCalls.length; const next = await runSuite({ ...h.options, resume: first.result!.manifest.runId }); expect(next.exitCode).toBe(0); expect(next.result?.cases[0]?.attempt).toBe(1); expect(h.executor.doGenerateCalls).toHaveLength(calls);
  });
  it.each(['models', 'checkpoint', 'trace', 'index', 'final', 'temp-write'] as const)('%s await边界取消，磁盘结果必须incomplete并resume新attempt', async boundary => {
    const { artifacts } = await setup(); const ac = new AbortController(); let fired = false, finalizing = false, traceWritten = false;
    class InterruptStore extends ArtifactStore {
      override async publishJsonSelected<T>(rel: string, select: () => T): Promise<T> {
        if (boundary === 'final' && !fired && rel.endsWith('/result.json')) { fired = true; ac.abort(); }
        return super.publishJsonSelected(rel, () => {
          const chosen = select();
          if (boundary === 'temp-write' && !fired && rel.endsWith('/result.json')) { fired = true; setImmediate(() => ac.abort()); }
          return chosen;
        });
      }
      override async writeJson(rel: string, value: unknown) {
        await super.writeJson(rel, value);
        if (rel.endsWith('/models.json')) { finalizing = true; if (boundary === 'models' && !fired) { fired = true; ac.abort(); } }
        if (boundary === 'index' && traceWritten && !fired && rel.endsWith('/evidence/index.json')) { fired = true; ac.abort(); }
      }
      override async writeBytes(rel: string, bytes: Uint8Array) {
        await super.writeBytes(rel, bytes);
        if (rel.endsWith('/trace.jsonl')) { traceWritten = true; if (boundary === 'trace' && !fired) { fired = true; ac.abort(); } }
      }
      override async readBytes(rel: string) {
        const bytes = await super.readBytes(rel);
        if (boundary === 'checkpoint' && !fired && finalizing && rel.includes('/evidence/files/')) { fired = true; ac.abort(); }
        return bytes;
      }
    }
    const store = new InterruptStore(path.dirname(artifacts.root)); const h = harness(store);
    const r = await runSuite({ ...h.options, signal: ac.signal }); expect(fired).toBe(true); expect(r.exitCode).toBe(2); expect(r.interrupted).toBe(true);
    const id = r.result!.manifest.runId; const saved = JSON.parse((await store.readBytes(`runs/${id}/cases/M-TC-1/attempts/1/result.json`))!.toString()); expect(saved).toMatchObject({ complete: false, status: 'BLOCKED' });
    const nextModel = scriptedModel([finish('unclear', [], '新尝试观察不足'), finish('unclear', [], '独立观察不足')]);
    const resumed = await runSuite({ artifacts: store, resume: id, resilience: h.options.resilience, modelOptions: { factories: { ollama: () => nextModel } }, transport: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) }); expect(resumed.result?.cases[0]?.attempt).toBe(2);
    expect(await store.readBytes(`runs/${id}/cases/M-TC-1/attempts/1/evidence/index.json`)).toBeDefined();
  });
});
describe('最终修复 I1 动态凭证落盘前安全', () => {
  it.each(['success', 'failure', 'abort', 'known', 'missing'] as const)('真实command随机凭证早期反射：%s全目录/写入入口无原值', async mode => {
    const { randomUUID } = await import('node:crypto');
    const { readdir, readFile } = await import('node:fs/promises');
    const { generateReport } = await import('../../report/src/index');
    const secret = `runtime-${randomUUID()}`;
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/credential' ? JSON.stringify(mode === 'failure' ? { invalid: secret } : { headers: { Authorization: `Bearer ${secret}` } }) : JSON.stringify({ ordinary: secret }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const command = { program: process.execPath, argv: ['-e', `require('node:http').get('${baseURL}/credential',r=>r.pipe(process.stdout))`], env: {} };
      const { artifacts, approvals } = await setup({ actor: { kind: 'command', command }, ...(mode === 'known' || mode === 'missing' ? { fixtures: [mode] } : {}) });
      const environments = { version: 1, environments: { local: { baseURL, healthcheck: `${baseURL}/health`, reset: null } } };
      const guardrails = { allowedHosts: [new URL(baseURL).host], forbidden: [], redactFields: [] };
      const catalog = { version: 1, operations: { seed: { environment: 'local', method: 'POST', path: '/seed', description: '准备', knowledge: [], sources: [clause.source] } } };
      const fixtures = { version: 1, fixtures: { known: { kind: 'http', operation: 'seed', body: {} } } };
      for (const [name, value] of Object.entries({ 'environments.yaml': environments, 'guardrails.yaml': guardrails, 'api-catalog.yaml': catalog, 'fixtures.yaml': fixtures })) { await artifacts.writeYaml(`system/${name}`, value); approvals.approve('profile', name, value, '人工'); }
      await approvals.save(artifacts);
      const attempted: string[] = []; const ac = new AbortController();
      class ObservedStore extends ArtifactStore {
        override async writeBytes(rel: string, bytes: Uint8Array) { attempted.push(Buffer.from(bytes).toString()); await super.writeBytes(rel, bytes); }
        override async publishExclusive(rel: string, bytes: Uint8Array) { attempted.push(Buffer.from(bytes).toString()); await super.publishExclusive(rel, bytes); }
      }
      const store = new ObservedStore(path.dirname(artifacts.root));
      let modelCalls = 0;
      const model = new MockLanguageModelV4({ doGenerate: async opts => {
        if (mode === 'missing') {
          const ids = [...new Set([...JSON.stringify(opts.prompt).matchAll(/e-[a-f0-9-]{36}/g)].map(match => match[0]))];
          return scriptedModel([modelCalls++ === 0 ? { toolCalls: [{ name: 'http_request', input: { url: `${baseURL}/seed?ordinary=${secret}`, method: 'POST' } }] } : { toolCalls: [{ name: 'finish', input: { prepared: true, evidenceIds: ids } }] }]).doGenerate(opts);
        }
        if (mode !== 'success') return scriptedModel([finish('unclear', [], '观察不足')]).doGenerate(opts);
        const ids = [...new Set([...JSON.stringify(opts.prompt).matchAll(/e-[a-f0-9-]{36}/g)].map(match => match[0]))];
        return scriptedModel([modelCalls++ === 0 ? { toolCalls: [{ name: 'http_request', input: { url: `${baseURL}/value` } }] } : finish('pass', ids)]).doGenerate(opts);
      } });
      const r = await runSuite({ artifacts: store, signal: ac.signal, modelOptions: { factories: { ollama: () => model } }, ...(mode === 'abort' ? { transport: async () => { ac.abort(); return new Response(JSON.stringify({ ordinary: secret }), { headers: { 'content-type': 'application/json' } }); } } : {}) });
      expect(r.exitCode).toBe(mode === 'success' ? 0 : 2); expect(r.result, JSON.stringify(r)).toBeDefined();
      await generateReport(store, r.result!.manifest.runId);
      const all: string[] = [];
      async function scan(dir: string) { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await scan(file); else all.push((await readFile(file)).toString()); } }
      await scan(store.root);
      expect(attempted.join('\n')).not.toContain(secret); expect(all.join('\n')).not.toContain(secret);
      const prefix = `runs/${r.result!.manifest.runId}/cases/M-TC-1/attempts/1`;
      const records = JSON.parse((await store.readBytes(`${prefix}/evidence/index.json`))!.toString());
      const evidence = new EvidenceStore(store, { runId: r.result!.manifest.runId, caseId: 'M-TC-1', attempt: 1 }, createEvidenceRedactor());
      for (const record of records) await evidence.verify(record);
      expect((await evidence.readTextEvidence(records[0].id)).sourceIncomplete).toBe(true);
      if (mode === 'success') { expect(model.doGenerateCalls).toHaveLength(3); expect(r.result!.status).toBe('PASS'); expect(records.some((record: any) => record.phase === 'execution')).toBe(true); }
      if (mode === 'known') { expect(model.doGenerateCalls).toHaveLength(0); expect(r.result!.cases[0]!.reason).toContain('夹具'); }
      if (mode === 'abort') expect(r.result!.cases[0]!.complete).toBe(false);
      if (mode === 'missing') { expect(model.doGenerateCalls).toHaveLength(4); expect(r.result!.status).toBe('BLOCKED'); expect(records.every((record: any) => record.phase === 'preparation')).toBe(true); }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
describe('最终修复 I2 展示文本', () => {
  it.each(["'", '"', '`', '<', '>', '(),;!$:+/?', '%27', '%22%60%3C%3E', '{"safe":"JSON_SUFFIX_SECRET_918"}'].flatMap(boundary => ['finish', 'blocked'].map(exit => ({ boundary, exit }))))('残留I2 URL边界 $boundary / $exit 经真实提交及三报告不留后缀', async ({ boundary, exit }) => {
    const { generateReport } = await import('../../report/src/index');
    const { artifacts } = await setup(); const h = harness(artifacts);
    const reasoning = `请检查 https://example.invalid/reset?password=BEFORE_SECRET_918${boundary}AFTER_SECRET_918&mode=safe 然后继续`;
    const model = new MockLanguageModelV4({ doGenerate: async opts => {
      if (exit === 'blocked') return scriptedModel([{ toolCalls: [{ name: 'report_blocked', input: { reason: reasoning } }] }]).doGenerate(opts);
      const ids = [...new Set([...JSON.stringify(opts.prompt).matchAll(/e-[a-f0-9-]{36}/g)].map(match => match[0]))];
      return scriptedModel([ids.length ? finish('pass', ids, reasoning) : { toolCalls: [{ name: 'http_request', input: { url: 'http://localhost:39999/value' } }] }]).doGenerate(opts);
    } });
    const r = await runSuite({ ...h.options, modelOptions: { factories: { ollama: () => model } } });
    expect(r.exitCode).toBe(exit === 'finish' ? 0 : 2);
    await generateReport(artifacts, r.result!.manifest.runId);
    for (const rel of ['cases/M-TC-1/attempts/1/result.json', 'results.json', 'junit.xml', 'report/index.html']) {
      const saved = (await artifacts.readBytes(`runs/${r.result!.manifest.runId}/${rel}`))!.toString();
      expect(saved, rel).not.toMatch(/BEFORE_SECRET_918|AFTER_SECRET_918|JSON_SUFFIX_SECRET_918/);
      // PASS的JUnit原格式不展示reasoning；BLOCKED原因在三种格式都实际可查。
      if (rel !== 'junit.xml' || exit === 'blocked') for (const safe of ['请检查', '/reset', 'mode=safe', '然后继续']) expect(saved, rel).toContain(safe);
    }
    expect(r.result!.usage.inputTokens).toBe(exit === 'finish' ? 30 : 20);
    expect(r.result!.budget.tokens).toBe(exit === 'finish' ? 45 : 30);
  });
  it('report_blocked的JSON/URL原因经case/summary/三格式统一清洗', async () => {
    const { generateReport } = await import('../../report/src/index');
    const { artifacts } = await setup();
    const reason = JSON.stringify({ password: 'BLOCK_JSON_SECRET', url: 'https://example.invalid/reset?password=BLOCK_URL_SECRET&mode=safe', safe: '保留原因' });
    const model = scriptedModel([{ toolCalls: [{ name: 'report_blocked', input: { reason } }] }, { toolCalls: [{ name: 'report_blocked', input: { reason } }] }]);
    const r = await runSuite({ artifacts, modelOptions: { factories: { ollama: () => model } }, transport: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
    await generateReport(artifacts, r.result!.manifest.runId);
    for (const rel of ['cases/M-TC-1/attempts/1/result.json', 'results.json', 'junit.xml', 'report/index.html']) {
      const saved = (await artifacts.readBytes(`runs/${r.result!.manifest.runId}/${rel}`))!.toString(); expect(saved).not.toMatch(/BLOCK_JSON_SECRET|BLOCK_URL_SECRET/); expect(saved).toContain('保留原因'); expect(saved).toContain('mode=safe');
    }
  });
  it.each(['json', 'url', 'prose'] as const)('%s最终reasoning经真实提交及三格式无语义秘密且保留安全字段', async kind => {
    const { generateReport } = await import('../../report/src/index');
    const { artifacts } = await setup(); const h = harness(artifacts);
    const url = 'https://example.invalid/reset?password=URL_SECRET_518&mode=safe';
    const reasoning = kind === 'json' ? JSON.stringify({ url, callbackURL: '/reset?password=REL_SECRET_518&mode=safe', password: 'JSON_SECRET_518', safe: '保留安全值' }) : kind === 'url' ? url : `请检查 ${url} 然后保留安全值`;
    const model = new MockLanguageModelV4({ doGenerate: async opts => {
      const ids = [...new Set([...JSON.stringify(opts.prompt).matchAll(/e-[a-f0-9-]{36}/g)].map(m => m[0]))];
      return scriptedModel([ids.length ? finish('pass', ids, reasoning) : { toolCalls: [{ name: 'http_request', input: { url: 'http://localhost:39999/value' } }] }]).doGenerate(opts);
    } });
    const r = await runSuite({ ...h.options, modelOptions: { factories: { ollama: () => model } } }); expect(r.exitCode).toBe(0);
    await generateReport(artifacts, r.result!.manifest.runId);
    for (const rel of ['cases/M-TC-1/attempts/1/result.json', 'results.json', 'junit.xml', 'report/index.html']) {
      const saved = (await artifacts.readBytes(`runs/${r.result!.manifest.runId}/${rel}`))!.toString();
      expect(saved).not.toMatch(/URL_SECRET_518|JSON_SECRET_518|REL_SECRET_518/);
      if (rel !== 'junit.xml') { expect(saved).toContain('mode=safe'); if (kind !== 'url') expect(saved).toContain('保留安全值'); }
    }
    expect(r.result!.usage.inputTokens).toBe(30); expect(r.result!.budget.tokens).toBe(45);
  });
});
describe('最终修复 I3 准备完成凭据', () => {
  it('真实loopback POST造数后GET状态，准备凭据不送review且业务单独采证PASS', async () => {
    let seeded = false; const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && req.url === '/seed') seeded = true;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ seeded, value: seeded ? 'ok' : 'missing' }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const { artifacts, approvals } = await setup({ fixtures: ['missing'] });
      const environments = { version: 1, environments: { local: { baseURL, healthcheck: `${baseURL}/health`, reset: null } } };
      const guards = { allowedHosts: [new URL(baseURL).host], forbidden: [], redactFields: [] };
      for (const [name, value] of Object.entries({ 'environments.yaml': environments, 'guardrails.yaml': guards })) { await artifacts.writeYaml(`system/${name}`, value); approvals.approve('profile', name, value, '人工'); } await approvals.save(artifacts);
      let calls = 0;
      const executor = new MockLanguageModelV4({ doGenerate: async opts => {
        calls++;
        const ids = [...new Set([...JSON.stringify(opts.prompt).matchAll(/e-[a-f0-9-]{36}/g)].map(match => match[0]))];
        const step = calls === 1 ? { toolCalls: [{ name: 'http_request', input: { url: `${baseURL}/seed`, method: 'POST' } }] } : calls === 2 ? { toolCalls: [{ name: 'http_request', input: { url: `${baseURL}/state` } }] } : calls === 3 ? { toolCalls: [{ name: 'finish', input: { prepared: true, evidenceIds: ids } }] } : calls === 4 ? { toolCalls: [{ name: 'http_request', input: { url: `${baseURL}/value` } }] } : finish('pass', ids);
        return scriptedModel([step]).doGenerate(opts);
      } });
      const reviewer = new MockLanguageModelV4({ doGenerate: async opts => {
        const ids = [...new Set([...JSON.stringify(opts.prompt).matchAll(/e-[a-f0-9-]{36}/g)].map(match => match[0]))];
        return scriptedModel([finish('pass', ids)]).doGenerate(opts);
      } });
      const r = await runSuite({ artifacts, modelOptions: { factories: { ollama: ({ modelId }) => modelId === 'e' ? executor : reviewer } } });
      expect(r.exitCode).toBe(0); expect(seeded).toBe(true); expect(requests).toEqual(['GET /health', 'POST /seed', 'GET /state', 'GET /value']);
      expect(JSON.stringify(reviewer.doGenerateCalls)).not.toMatch(/\/seed|\/state/);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it.each(['empty', 'health', 'error', 'truncated', 'valid'] as const)('%s只接受当前准备窗口完整成功HTTP观察，三次invalid前不认证/执行', async kind => {
    const { artifacts } = await setup({ fixtures: ['missing'] }); let calls = 0; const urls: string[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async opts => {
      calls++;
      const runId = (await artifacts.list('runs'))[0]!;
      const index = JSON.parse((await artifacts.readBytes(`runs/${runId}/cases/M-TC-1/attempts/1/evidence/index.json`))!.toString());
      if (kind !== 'empty' && kind !== 'health' && calls === 1) return scriptedModel([{ toolCalls: [{ name: 'http_request', input: { url: 'http://localhost:39999/seed', method: 'POST' } }] }]).doGenerate(opts);
      if (kind === 'valid' && calls === 2) return scriptedModel([{ toolCalls: [{ name: 'http_request', input: { url: 'http://localhost:39999/state' } }] }]).doGenerate(opts);
      if (kind === 'valid' && calls > 3) return scriptedModel([finish('unclear', [], '没有业务观察')]).doGenerate(opts);
      const evidenceIds = kind === 'empty' ? [] : [index.at(-1)!.id];
      return scriptedModel([{ toolCalls: [{ name: 'finish', input: { prepared: true, ...(kind === 'empty' ? {} : { evidenceIds }) } }] }]).doGenerate(opts);
    } });
    const r = await runSuite({ artifacts, modelOptions: { factories: { ollama: () => model } }, transport: async url => { urls.push(url); return new Response(JSON.stringify({ value: kind === 'truncated' ? 'x'.repeat(300000) : 'seeded' }), { status: kind === 'error' && url.endsWith('/seed') ? 500 : 200, headers: { 'content-type': 'application/json' } }); } });
    expect(r.exitCode).toBe(2);
    if (kind === 'valid') { expect(r.result!.status).toBe('UNCLEAR'); expect(urls.map(url => new URL(url).pathname)).toEqual(['/health', '/seed', '/state']); expect(model.doGenerateCalls).toHaveLength(5); expect(JSON.stringify(model.doGenerateCalls[4]!.prompt)).not.toContain('/state'); }
    else { expect(r.result!.status).toBe('BLOCKED'); expect(model.doGenerateCalls).toHaveLength(kind === 'empty' || kind === 'health' ? 3 : 4); const index = JSON.parse((await artifacts.readBytes(`runs/${r.result!.manifest.runId}/cases/M-TC-1/attempts/1/evidence/index.json`))!.toString()); expect(index.every((record: any) => record.phase === 'preparation')).toBe(true); expect(r.result!.cases[0]!.reason).toContain('3'); }
  });
});
describe('最终修复 I4 DB业务证据资格', () => {
  it.each(['blocked', 'database', 'timeout', 'cancelled', 'success'] as const)('%s生产DB信封不能用错误审计满足业务判定', async status => {
    const { artifacts } = await setup({ evidence: 'db' });
    const run = await RunStore.create(artifacts, { fingerprint: `sha256:${'a'.repeat(64)}`, environment: 'local', selectedCaseIds: [tc.id] }, {});
    const store = new EvidenceStore(artifacts, { runId: run.manifest.runId, caseId: tc.id, attempt: 1 }, createEvidenceRedactor());
    const record = await store.saveJson('db', status === 'success' ? { status, sent: true, rows: [{ status: 'blocked', sent: false, value: '业务字段' }], truncated: false } : { status, sent: status !== 'blocked', message: '失败审计' }, { actionId: 'a-query', phase: 'execution' });
    const text = (await createEvidencePresenter(store)([record.id], { ref: 'mock:a', signal: new AbortController().signal }))[0]!;
    const result = await validateJudgements({ judgements: [{ expectationId: 'E1', verdict: 'pass', reasoning: '观察', evidenceIds: [record.id] }] }, [{ id: 'E1', text: '业务结果', evidence: ['db'] }], [record], store, new Map([[record.id, text]]));
    expect(result.ok).toBe(status === 'success'); expect(text.truncated).toBe(status !== 'success');
    expect((await validateJudgements({ judgements: [{ expectationId: 'E1', verdict: 'unclear', reasoning: '不足', evidenceIds: [] }] }, [{ id: 'E1', text: '业务结果', evidence: ['db'] }], [record], store, new Map())).ok).toBe(true);
  });
  it.each(['pass', 'unclear'] as const)('真实DB工具DROP拒绝零连接，双判%s只能阻断或无证据unclear', async verdict => {
    const { artifacts, approvals } = await setup({ evidence: 'db' });
    const db = { version: 1, connection: { kind: 'postgres', env: 'READ_DB' }, queries: {} };
    await artifacts.writeYaml('system/data-model.yaml', db); approvals.approve('profile', 'data-model.yaml', db, '人工'); await approvals.save(artifacts);
    let connections = 0, calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async opts => {
      const ids = [...new Set([...JSON.stringify(opts.prompt).matchAll(/e-[a-f0-9-]{36}/g)].map(m => m[0]))];
      return scriptedModel([calls++ === 0 ? { toolCalls: [{ name: 'db_query', input: { sql: 'DROP TABLE items' } }] } : finish(verdict, verdict === 'unclear' ? [] : ids)]).doGenerate(opts);
    } });
    const r = await runSuite({ artifacts, env: { READ_DB: 'postgres://reader:secret@localhost:5432/test?sslmode=disable' }, createConnection: () => { connections++; throw new Error('不应连接'); }, modelOptions: { factories: { ollama: () => model } }, transport: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
    expect(connections).toBe(0); expect(r.result!.status).toBe(verdict === 'unclear' ? 'UNCLEAR' : 'BLOCKED'); expect(r.exitCode).toBe(2);
    expect(model.doGenerateCalls).toHaveLength(verdict === 'unclear' ? 3 : 7);
  });
});
describe('最终修复 I5 真实presenter取消来源', () => {
  it.each(['cancel', 'disk-abort', 'deadline', 'review-cancel', 'review-disk-abort'] as const)('%s读取边界不新增provider，正常取消2/宿主原错3', async kind => {
    const { artifacts } = await setup(); const ac = new AbortController(); let fired = false, afterFinishReads = 0;
    if (kind === 'deadline') { const config = await artifacts.loadConfig(); config.budget.perCase.minutes = 0.005; await artifacts.writeYaml('config.yaml', config); }
    class BoundaryStore extends ArtifactStore {
      override async readBytes(rel: string) {
        const bytes = await super.readBytes(rel);
        if (rel.includes('/evidence/files/') && bytes?.toString().includes('/value') && h.executor.doGenerateCalls.length >= 2) afterFinishReads++;
        if (!fired && rel.includes('/evidence/files/') && bytes?.toString().includes('/value') && (!kind.startsWith('review-') || afterFinishReads >= 2)) {
          fired = true;
          if (kind === 'deadline') await new Promise<void>(resolve => setTimeout(resolve, 350));
          else ac.abort();
          if (kind.endsWith('disk-abort')) throw new Error('真实读取错误与abort同时发生');
        }
        return bytes;
      }
    }
    const store = new BoundaryStore(path.dirname(artifacts.root)); const h = harness(store);
    const r = await runSuite({ ...h.options, signal: ac.signal });
    expect(fired).toBe(true); expect(r.exitCode).toBe(kind.endsWith('disk-abort') ? 3 : 2); expect(r.interrupted).toBe(kind !== 'deadline');
    expect(h.executor.doGenerateCalls).toHaveLength(kind.startsWith('review-') ? 2 : 1); expect(h.reviewer.doGenerateCalls).toHaveLength(0); expect(h.fallback.doGenerateCalls).toHaveLength(0);
    expect(r.result!.cases[0]!.complete).toBe(kind === 'deadline');
    if (kind === 'deadline') expect(r.result!.cases[0]!.budget.exhausted).toBe(true);
  });
});
export { setup, harness, finish };
