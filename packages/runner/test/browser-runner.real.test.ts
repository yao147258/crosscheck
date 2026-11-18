import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { Approvals, ArtifactStore, ClauseSchema, TestCaseSchema, loadProfile, EvidenceRecordSchema } from '@crosscheck/core';
import { BrowserCleanupError, launchBrowserSession } from '@crosscheck/tools';
import { scriptedModel } from '../../agent/src/testing/scripted-model';
import { runSuite } from '../src/run-suite';

const skip = process.env.CROSSCHECK_REAL_BROWSER !== '1';
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }))); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const secret = 'RUNNER_FORM_SENTINEL_9282';
async function setup(options: { verdict?: string; fallback?: boolean; steps?: number; minutes?: number; authWait?: boolean; fixtures?: boolean; failedPrepare?: boolean; anonymousPrepare?: boolean; replay?: boolean } = {}) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === '/health' || req.url === '/reset' || req.url === '/known' || req.url === '/who') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ actor: req.headers.cookie?.includes('sid=') ? 'member' : 'guest' })); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/login') res.end('<form action="/logged" method="post"><input name="password" type="password"><button>登录</button></form>');
    else if (req.url === '/logged') { res.setHeader('Set-Cookie', `sid=${secret}; Path=/`); res.end('<p id="ready">登录成功</p>'); }
    else if (req.url === '/prepare') {
      if (options.anonymousPrepare) res.setHeader('Set-Cookie', 'sid=PREPARE_LOGIN_MEMBER; Path=/');
      res.end(`<p>准备完成</p>${options.anonymousPrepare ? '<script>localStorage.setItem("actor","member");sessionStorage.setItem("actor","member");window.actor="member"</script>' : ''}`);
    }
    else res.end(`<label>名称<input id="name"></label><button onclick="document.querySelector('#result').textContent='保存成功'">保存</button><p id="result">等待保存</p>`);
  }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = await mkdtemp(path.join(tmpdir(), 'browser-runner-')); roots.push(root); const artifacts = new ArtifactStore(root);
  const userHome = path.join(root, 'user'); await mkdir(path.join(userHome, '.crosscheck'), { recursive: true });
  await writeFile(path.join(userHome, '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r', ...(options.fallback ? { fallback: { reviewer: 'mock:f' } } : {}) }, providers: { mock: { type: 'openai', baseURL: 'https://example.invalid/v1', apiKey: 'fixture-key' } }, capabilities: { 'mock:e': { images: true }, 'mock:r': { images: true }, 'mock:f': { images: false } } }));
  await artifacts.writeYaml('config.yaml', { defaultEnvironment: 'local', budget: { perCase: { steps: options.steps ?? 30, tokens: 100000, minutes: options.minutes ?? 1 } } });
  const source = { file: '需求.md', line: 1, excerpt: '保存后显示成功' };
  const clause = ClauseSchema.parse({ id: 'M-AC-1', text: '填写并保存后显示成功', source });
  const tc = TestCaseSchema.parse({ id: 'M-TC-1', covers: [clause.id], actor: 'member', fixtures: options.fixtures ? ['known', 'reset', 'missing'] : [], steps: ['保存表单'], expectations: [{ id: 'E1', text: '保存后页面显示保存成功', evidence: ['dom', 'screenshot'] }] });
  const files = { 'environments.yaml': { version: 1, environments: { local: { baseURL, healthcheck: `${baseURL}/health`, reset: options.fixtures ? 'reset' : null } } }, 'auth.yaml': { version: 1, actors: { member: options.anonymousPrepare ? { kind: 'anonymous' } : { kind: options.replay ? 'replay' : 'form', environment: 'local', actions: [{ kind: 'goto', url: '/login' }, ...(options.authWait ? [{ kind: 'waitFor', selector: '#never' }] : [{ kind: 'fill', selector: 'input', env: 'PASSWORD' }, { kind: 'click', selector: 'button' }, { kind: 'waitFor', selector: '#ready' }])] } } }, 'api-catalog.yaml': { version: 1, operations: options.fixtures ? Object.fromEntries(['reset', 'known'].map(name => [name, { environment: 'local', method: 'POST', path: `/${name}`, description: name, sources: [source] }])) : {} }, 'pages.yaml': { version: 1, pages: {} }, 'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: options.fixtures ? { reset: { kind: 'http', operation: 'reset' }, known: { kind: 'http', operation: 'known' } } : {} }, 'guardrails.yaml': { allowedHosts: [new URL(baseURL).host] } };
  for (const [name, data] of Object.entries(files)) await artifacts.writeYaml(`system/${name}`, data);
  await artifacts.saveClauses('M', [clause]); await artifacts.saveCases('M', [tc]); const approvals = Approvals.empty();
  for (const [name, data] of Object.entries(await loadProfile(artifacts))) approvals.approve('profile', name, data, '人工');
  approvals.approve('clause', clause.id, clause, '人工'); approvals.approveCase(tc, [clause], '人工'); await approvals.save(artifacts);
  let execute = 0, prepare = 0;
  const index = async () => { const runId = (await artifacts.list('runs'))[0]!; const attempts = await artifacts.list(`runs/${runId}/cases/M-TC-1/attempts`); return (await artifacts.readJson(`runs/${runId}/cases/M-TC-1/attempts/${Math.max(...attempts.map(Number))}/evidence/index.json`, EvidenceRecordSchema.array()))!; };
  const finish = (verdict: string, ids: string[]) => ({ toolCalls: [{ name: 'finish', input: { judgements: [{ expectationId: 'E1', verdict, evidenceIds: ids, reasoning: '按真实截图与可见成功文本判断，未推测隐藏输入值' }] } }] });
  const latest = async (phase: 'execution' | 'preparation') => { const records = (await index()).filter(r => r.phase === phase); return ['dom', 'screenshot'].flatMap(type => records.filter(r => r.type === type).slice(-1).map(r => r.id)); };
  const executor = new MockLanguageModelV4({ doGenerate: async opts => {
    const preparation = JSON.stringify(opts.prompt).includes('missing');
    if (preparation && options.fixtures && !JSON.stringify(opts.prompt).includes('保存表单')) {
      const turn = prepare++;
      const response = turn === 0 ? { toolCalls: [{ name: 'browser_action', input: { kind: 'navigate', url: '/prepare' } }] } : options.failedPrepare && turn === 1 ? { toolCalls: [{ name: 'browser_action', input: { kind: 'click', locator: { strategy: 'css', value: '#missing' } } }] } : { toolCalls: [{ name: 'finish', input: { prepared: true, evidenceIds: await latest('preparation') } }] };
      return scriptedModel([response]).doGenerate(opts);
    }
    const actions = [{ kind: 'navigate', url: '/' }, { kind: 'fill', locator: { strategy: 'css', value: '#name' }, value: 'ORDINARY_FILL_SENTINEL' }, { kind: 'click', locator: { strategy: 'role', value: 'button', name: '保存' } }, { kind: 'wait', locator: { strategy: 'text', value: '保存成功' }, state: 'visible' }];
    const response = execute < actions.length ? { toolCalls: [{ name: 'browser_action', input: actions[execute++]! }] } : finish('pass', await latest('execution'));
    return scriptedModel([response]).doGenerate(opts);
  } });
  const reviewer = new MockLanguageModelV4({ doGenerate: async opts => { expect(opts.tools?.map(t => t.name)).toEqual(['finish', 'report_blocked']); if (options.fallback) throw new Error('切换无图模型'); return scriptedModel([finish(options.verdict ?? 'pass', await latest('execution'))]).doGenerate(opts); } });
  const fallback = new MockLanguageModelV4({ doGenerate: async opts => scriptedModel([finish('pass', await latest('execution'))]).doGenerate(opts) });
  return { artifacts, requests, baseURL, executor, reviewer, fallback, index, options: { artifacts, userConfigHome: userHome, env: { PASSWORD: secret }, modelOptions: { factories: { openai: ({ modelId }: { modelId: string }) => modelId === 'e' ? executor : modelId === 'r' ? reviewer : fallback } }, resilience: { retries: 0, baseDelayMs: 0 } } };
}
describe.skipIf(skip)('runner 真实浏览器与脚本模型', () => {
  it.each([['pass', 'PASS'], ['fail', 'DISPUTED'], ['unclear', 'UNCLEAR']] as const)('表单与盲审 %s→%s，浏览器关闭后提交', async (verdict, status) => {
    const s = await setup({ verdict }); let closed = false, launches = 0;
    const result = await runSuite({ ...s.options, launchBrowser: async opts => { launches++; const session = await launchBrowserSession(opts); return { ...session, close: async () => { await session.close(); closed = true; } }; } });
    expect(result.result?.status, JSON.stringify(result.result?.cases)).toBe(status); expect(launches).toBe(1); expect(closed).toBe(true);
    const runId = result.result!.manifest.runId;
    const trace = (await s.artifacts.readBytes(`runs/${runId}/cases/M-TC-1/attempts/1/trace.jsonl`))!.toString();
    expect(trace).not.toMatch(/ORDINARY_FILL_SENTINEL|RUNNER_FORM_SENTINEL_9282/);
    const events = trace.trim().split('\n').map(line => JSON.parse(line));
    expect(events.find(e => e.action?.type === 'browser_action' && e.action.locator?.value === '#name')).toBeDefined();
    expect(events.find(e => e.action?.input?.kind === 'secretRef' && e.action.input.env === 'PASSWORD')).toBeDefined();
    expect(JSON.stringify(s.reviewer.doGenerateCalls)).not.toContain('ORDINARY_FILL_SENTINEL');
    expect(s.reviewer.doGenerateCalls[0]!.prompt.some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'file'))).toBe(true);
  }, 30000);
  it('无图 fallback 不继承主模型 shown 或伪造 PASS', async () => {
    const s = await setup({ fallback: true }); const result = await runSuite(s.options);
    expect(result.result?.status).toBe('BLOCKED'); expect(s.fallback.doGenerateCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(s.fallback.doGenerateCalls)).not.toContain('image/png');
  }, 30000);
  it('reset→普通夹具→缺失 browser prepare→auth，prepare 不是业务判定', async () => {
    const s = await setup({ fixtures: true }); const result = await runSuite(s.options);
    expect(result.result?.status, JSON.stringify({ result, calls: s.executor.doGenerateCalls.map(x => x.prompt.filter(m => m.role === 'tool')) })).toBe('PASS');
    expect(s.requests.filter(x => ['/reset', '/known', '/prepare', '/login'].includes(x))).toEqual(['/reset', '/known', '/prepare', '/login']);
    expect(result.result?.cases[0]?.reliability.errors).toContain('fixture-ad-hoc:missing');
    expect((await s.index()).filter(x => x.phase === 'preparation').length).toBeGreaterThan(0);
  }, 30000);
  it('prepare 自动登录 cookie/storage/页面状态不污染 anonymous 浏览器或 HTTP，夹具不重放', async () => {
    const s = await setup({ fixtures: true, anonymousPrepare: true });
    let turn = 0;
    const executor = new MockLanguageModelV4({ doGenerate: async opts => {
      if (!JSON.stringify(opts.prompt).includes('保存表单')) return s.executor.doGenerate(opts);
      if (turn++ === 0) return scriptedModel([{ toolCalls: [{ name: 'http_request', input: { url: `${s.baseURL}/who` } }] }]).doGenerate(opts);
      return s.executor.doGenerate(opts);
    } });
    const snapshots: unknown[] = []; let launches = 0;
    const result = await runSuite({ ...s.options, modelOptions: { factories: { openai: ({ modelId }) => modelId === 'e' ? executor : s.reviewer } }, launchBrowser: async opts => {
      launches++;
      const session = await launchBrowserSession(opts);
      return { ...session, close: async () => {
        if (!session.page.isClosed()) snapshots.push({ cookies: await session.context.cookies(), state: await session.page.evaluate(() => ({ local: localStorage.getItem('actor'), session: sessionStorage.getItem('actor'), actor: (window as any).actor ?? null })) });
        await session.close();
      } };
    } });
    expect(result.result?.status).toBe('PASS');
    const http = (await s.index()).find(r => r.type === 'network' && r.phase === 'execution')!;
    expect((await s.artifacts.readBytes(http.path))!.toString()).toContain('guest');
    expect(snapshots).toEqual([
      { cookies: [expect.objectContaining({ name: 'sid', value: 'PREPARE_LOGIN_MEMBER' })], state: { local: 'member', session: 'member', actor: 'member' } },
      { cookies: [], state: { local: null, session: null, actor: null } },
    ]);
    expect(launches).toBe(2);
    expect(s.requests.filter(x => ['/reset', '/known', '/prepare'].includes(x))).toEqual(['/reset', '/known', '/prepare']);
  }, 30000);
  it('正确环境 replay 仍通过真实表单认证', async () => {
    const s = await setup({ replay: true }); const result = await runSuite(s.options);
    expect(result.result?.status).toBe('PASS'); expect(s.requests).toContain('/logged');
  }, 30000);
  it('失败的浏览器准备动作不能以其前后截图与DOM伪造完成', async () => {
    const s = await setup({ fixtures: true, failedPrepare: true }); const result = await runSuite(s.options);
    expect(result.result?.status).toBe('BLOCKED'); expect(s.requests).not.toContain('/login'); expect(s.reviewer.doGenerateCalls).toHaveLength(0);
  }, 30000);
  it('清理故障是 hostError，不能提交 PASS', async () => {
    const s = await setup(); const result = await runSuite({ ...s.options, launchBrowser: async opts => { const session = await launchBrowserSession(opts); return { ...session, close: async () => { await session.close(); throw new BrowserCleanupError([new Error('清理失败')]); } }; } });
    expect(result.exitCode).toBe(3); expect(result.result?.cases[0]?.complete).toBe(false);
  }, 30000);
  it('取消关闭会话，resume 新 attempt 不复用会话', async () => {
    const s = await setup(), controller = new AbortController(); let launches = 0, closed = 0;
    const launchBrowser: typeof launchBrowserSession = async opts => { launches++; const session = await launchBrowserSession(opts); if (launches === 1) setTimeout(() => controller.abort(), 150); return { ...session, close: async () => { await session.close(); closed++; } }; };
    const first = await runSuite({ ...s.options, signal: controller.signal, launchBrowser });
    expect(first.interrupted).toBe(true); expect(first.result?.cases[0]?.complete).toBe(false); expect(closed).toBeGreaterThan(0);
    const next = await runSuite({ ...s.options, resume: first.result!.manifest.runId, launchBrowser });
    expect(next.result?.cases[0]?.attempt).toBe(2); expect(launches).toBe(2);
  }, 30000);
  it('浏览器采证真实存储失败即host-error，关闭和flush完成后才commit', async () => {
    const s = await setup(); let closed = false, committed = false;
    class BrokenStore extends ArtifactStore {
      override async publishExclusive(rel: string, bytes: Uint8Array) { if (rel.endsWith('.png')) throw new Error('PNG磁盘故障'); return super.publishExclusive(rel, bytes); }
      override async publishJsonSelected<T>(rel: string, select: () => T): Promise<T> { if (rel.endsWith('/result.json')) { expect(closed).toBe(true); committed = true; } return super.publishJsonSelected(rel, select); }
    }
    const result = await runSuite({ ...s.options, artifacts: new BrokenStore(path.dirname(s.artifacts.root)), launchBrowser: async opts => { const session = await launchBrowserSession(opts); return { ...session, close: async () => { await session.close(); closed = true; } }; } });
    expect(result.exitCode).toBe(3); expect(result.result?.cases[0]?.complete).toBe(false); expect(committed).toBe(true);
  }, 30000);
  it('认证和执行模型共享步数，模型工具不重复计步', async () => {
    const s = await setup(); const result = await runSuite(s.options);
    expect(result.result?.status).toBe('PASS'); expect(result.result?.cases[0]?.budget.used.steps).toBe(10);
    expect(result.result?.cases[0]?.reliability.attempts).toBe(6);
  }, 30000);
  it.each(['deadline', 'cancel'] as const)('批准认证wait共享%s并关闭会话，不进入执行模型', async kind => {
    const s = await setup({ authWait: true, minutes: kind === 'deadline' ? 0.05 : 1 });
    const controller = new AbortController(); let closed = false;
    const result = await runSuite({ ...s.options, signal: controller.signal, launchBrowser: async opts => {
      const session = await launchBrowserSession(opts);
      if (kind === 'cancel') session.page.on('domcontentloaded', () => { if (session.page.url().endsWith('/login')) controller.abort(); });
      return { ...session, close: async () => { await session.close(); closed = true; } };
    } });
    expect(result.exitCode).toBe(2); expect(closed).toBe(true); expect(s.executor.doGenerateCalls).toHaveLength(0); expect(s.reviewer.doGenerateCalls).toHaveLength(0);
    if (kind === 'deadline') { expect(result.result?.cases[0]?.budget.exhausted).toBe(true); expect(result.result?.cases[0]?.budget.reason).toContain('时长'); }
    else { expect(result.interrupted).toBe(true); expect(result.result?.cases[0]?.complete).toBe(false); }
  }, 30000);
  it('认证预算steps=1仅执行首个批准动作，第二步fill不发生', async () => {
    const s = await setup({ steps: 1 }); const result = await runSuite(s.options);
    expect(result.exitCode).toBe(2); expect(result.result?.cases[0]?.budget.used.steps).toBe(1);
    expect(result.result?.cases[0]?.budget.exhausted).toBe(true); expect(s.executor.doGenerateCalls).toHaveLength(0);
    expect(s.requests).toContain('/login'); expect(s.requests).not.toContain('/logged');
    const trace = (await s.artifacts.readBytes(`runs/${result.result!.manifest.runId}/cases/M-TC-1/attempts/1/trace.jsonl`))!.toString().trim().split('\n').map(line => JSON.parse(line));
    const actions = trace.filter(e => e.action.type === 'browser_action');
    expect(actions).toHaveLength(1); expect(actions[0].action.input.value.kind).toBe('navigate');
  }, 30000);
  it('共享步数耗尽后不启动 reviewer，仍 await 关闭', async () => {
    const s = await setup({ steps: 1 }); let closed = false;
    const result = await runSuite({ ...s.options, launchBrowser: async opts => { const session = await launchBrowserSession(opts); return { ...session, close: async () => { await session.close(); closed = true; } }; } });
    expect(result.result?.cases[0]?.budget.exhausted).toBe(true); expect(s.reviewer.doGenerateCalls).toHaveLength(0); expect(closed).toBe(true);
  }, 30000);
});
