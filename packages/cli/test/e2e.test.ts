import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, afterEach, expect, it } from 'vitest';
import { Approvals, ArtifactStore, ClauseSchema, TestCaseSchema, loadProfile } from '@crosscheck/core';
import { chromium } from 'playwright';
const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const harness = path.join(repo, 'packages/cli/dist/test-harness.js');
const production = path.join(repo, 'packages/cli/dist/index.js');
const runtime = process.env.CROSSCHECK_TEST_NODE ?? process.execPath;
const roots: string[] = []; const closers: (() => Promise<void>)[] = [];
beforeAll(async () => { await exec(process.execPath, ['scripts/build.mjs'], { cwd: repo }); await exec(process.execPath, ['scripts/build.mjs', '--harness'], { cwd: repo }); await exec(process.execPath, ['scripts/build.mjs', '--approval'], { cwd: repo }); });
afterEach(async () => { for (const close of closers.splice(0)) await close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const secret = 'PRIVATE_SENTINEL_TASK10_8734';
const attack = '</script><svg onload="globalThis.pwned=1"><img src="https://forbidden.invalid/x" onerror="globalThis.pwned=2">';
async function server(handler: RequestListener) {
  const s = createServer(handler); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  closers.push(async () => { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); });
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
async function setup(options: { browser?: boolean; count?: number; approved?: boolean; slow?: boolean } = {}) {
  let forbidden = 0, actions = 0, active = 0;
  const denied = await server((_req, res) => { forbidden++; res.end('{}'); });
  const base = await server((req, res) => {
    if (req.url === '/redirect-out') { res.writeHead(302, { location: denied }); res.end(); return; }
    if (req.url === '/api/action') actions++;
    if (options.slow && req.url === '/api/action') { active++; res.on('close', () => active--); return; }
    res.setHeader('content-type', 'application/json'); res.setHeader('set-cookie', `sid=${secret}`);
    res.end(JSON.stringify({ value: 'ok', text: attack, password: secret, access_token: secret }));
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'cli10-')); roots.push(root);
  const artifacts = new ArtifactStore(root);
  await artifacts.writeYaml('config.yaml', { models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:executor', reviewer: 'mock:reviewer' }, providers: { mock: { type: 'ollama' } }, defaultEnvironment: 'local', budget: { perCase: { steps: 20, tokens: 10000, minutes: 1 } } });
  const files = { 'environments.yaml': { version: 1, environments: { local: { baseURL: base, healthcheck: `${base}/health`, reset: null } } }, 'auth.yaml': { version: 1, actors: { guest: { kind: 'token', env: 'TEST_TOKEN', inject: { kind: 'header', name: 'Authorization' } } } }, 'api-catalog.yaml': { version: 1, operations: {} }, 'pages.yaml': { version: 1, pages: {} }, 'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: {} }, 'guardrails.yaml': { allowedHosts: [new URL(base).host] } };
  for (const [name, value] of Object.entries(files)) await artifacts.writeYaml(`system/${name}`, value);
  const clause = ClauseSchema.parse({ id: 'M-AC-1', text: attack, source: { file: '需求.md', line: 1, excerpt: attack } });
  const cases = Array.from({ length: options.count ?? 1 }, (_, i) => TestCaseSchema.parse({ id: `M-TC-${i + 1}`, covers: [clause.id], actor: 'guest', steps: ['POST /api/action', 'GET /item'], expectations: ['E1', 'E2'].map(id => ({ id, text: '返回真实ok', evidence: options.browser ? ['screenshot', 'dom'] : ['network'] })) }));
  await artifacts.saveClauses('M', [clause]); await artifacts.saveCases('M', cases);
  const approvals = Approvals.empty();
  for (const [name, value] of Object.entries(await loadProfile(artifacts))) approvals.approve('profile', name, value, '人工');
  approvals.approve('clause', clause.id, clause, '人工');
  if (options.approved !== false) for (const tc of cases) approvals.approveCase(tc, [clause], '人工');
  await approvals.save(artifacts);
  return { root, artifacts, base, counts: () => ({ forbidden, actions, active }), clause, approvals };
}
async function launch(s: Awaited<ReturnType<typeof setup>>, mode = 'pass', extra: string[] = []) {
  try { const out = await exec(runtime, [harness, 'run', '--project', s.root, ...extra], { env: { ...process.env, CROSSCHECK_TEST_MODE: mode, CROSSCHECK_TEST_BASE: s.base, TEST_TOKEN: secret }, timeout: 20000 }); return { code: 0, stdout: out.stdout }; }
  catch (error: any) { if (typeof error.code !== 'number') throw error; return { code: error.code as number, stdout: error.stdout as string }; }
}
async function result(s: Awaited<ReturnType<typeof setup>>) {
  const id = (await s.artifacts.list('runs'))[0]!;
  const data = JSON.parse((await s.artifacts.readBytes(`runs/${id}/results.json`))!.toString());
  return { id, data, html: s.artifacts.resolve(`runs/${id}/report/index.html`) };
}
async function assertNoSecret(directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await assertNoSecret(file);
    else expect((await readFile(file)).includes(Buffer.from(secret)), file).toBe(false);
  }
}
it.each([['pass', 'PASS', 0], ['fail', 'FAIL', 1], ['disputed', 'DISPUTED', 2], ['invalid', 'BLOCKED', 2]] as const)('真实HTTP/SDK子进程%s产生%s及三种报告且无秘密', async (mode, status, code) => {
  const s = await setup(); const out = await launch(s, mode); expect(out.code, out.stdout).toBe(code);
  const saved = await result(s); expect(saved.data.status).toBe(status); expect(saved.data.usage.cost).toBeNull();
  expect(await s.artifacts.readBytes(`runs/${saved.id}/junit.xml`)).toBeDefined(); expect(await readFile(saved.html, 'utf8')).toContain(status);
  expect(s.counts().forbidden).toBe(0); if (mode !== 'invalid') expect(s.counts().actions).toBe(1);
  await assertNoSecret(s.artifacts.resolve(`runs/${saved.id}`));
});
it('screenshot/dom需求在任何动作前BLOCKED，未确认同样可见', async () => {
  const s = await setup({ browser: true }); expect((await launch(s)).code).toBe(2); expect(s.counts().actions).toBe(0);
  expect((await result(s)).data.cases[0].reason).toContain('浏览器工具暂缓');
  const unapproved = await setup({ approved: false }); expect((await launch(unapproved)).code).toBe(2); expect(unapproved.counts().actions).toBe(0);
});
it('报告写入宿主故障优先退出3，不能用已完成PASS掩盖', async () => {
  const s = await setup(); expect((await launch(s)).code).toBe(0); const saved = await result(s);
  await rm(s.artifacts.resolve(`runs/${saved.id}/report`), { recursive: true });
  await s.artifacts.writeBytes(`runs/${saved.id}/report`, Buffer.from('不是目录'));
  expect((await launch(s, 'pass', ['--resume', saved.id])).code).toBe(3); expect(s.counts().actions).toBe(1);
  expect((await result(s)).data.status).toBe('PASS');
});
it('独立人工确认脚本使用真实approveCase恢复人工门禁，不在run自动批准', async () => {
  const s = await setup({ approved: false });
  expect((await launch(s)).code).toBe(2); expect(s.counts().actions).toBe(0);
  const out = await exec(runtime, [path.join(repo, 'packages/cli/dist/manual-approve.js'), s.root, '测试人工', '我已逐项审阅并确认']);
  expect(out.stdout).toContain('人工确认已保存'); expect((await launch(s)).code).toBe(0); expect(s.counts().actions).toBe(1);
});
it('真实redirect逐跳阻断，禁止终点0请求', async () => {
  const s = await setup(); const out = await launch(s, 'redirect'); expect(out.code).toBe(2); expect(s.counts().forbidden).toBe(0); expect((await result(s)).data.status).toBe('BLOCKED');
// 多轮阻断纠正、子进程冷启动及报告工件 I/O 均计入本项集成测试预算。
}, 15000);
it('完成case恢复不重放，输入变化/筛选未知与空交集不全绿', async () => {
  const s = await setup(); expect((await launch(s)).code).toBe(0); const saved = await result(s);
  expect((await launch(s, 'pass', ['--resume', saved.id])).code).toBe(0); expect(s.counts().actions).toBe(1);
  await s.artifacts.saveClauses('M', [{ ...s.clause, text: '变化' }]); s.approvals.approve('clause', s.clause.id, { ...s.clause, text: '变化' }, '人工'); await s.approvals.save(s.artifacts);
  expect((await launch(s, 'pass', ['--resume', saved.id])).code).toBe(2); expect(s.counts().actions).toBe(1);
  expect((await launch(s, 'pass', ['--module', 'unknown'])).code).toBe(2);
  expect((await launch(s, 'pass', ['--module', 'M', '--case', 'N-TC-9'])).code).toBe(2);
  const fresh = await launch(s); expect(fresh.code).toBe(2); expect(s.counts().actions).toBe(1);
  const ids = await s.artifacts.list('runs');
  const newest = ids.sort().at(-1)!; const current = JSON.parse((await s.artifacts.readBytes(`runs/${newest}/results.json`))!.toString());
  expect(current.cases[0]).toMatchObject({ status: 'BLOCKED', reason: expect.stringContaining('确认已失效') });
// 连续启动 6 个进程；生产入口引入 Ink 后单次冷启动约 0.7 秒，不能共用默认 5 秒预算。
}, 20000);
it('删除当前画像条款后生产CLI仍离线重建，file浏览器安全且可读', async () => {
  const s = await setup(); expect((await launch(s)).code).toBe(0); const saved = await result(s);
  await rm(s.artifacts.resolve('system'), { recursive: true }); await rm(s.artifacts.resolve('requirements'), { recursive: true }); await rm(s.artifacts.resolve('cases'), { recursive: true }); await rm(s.artifacts.resolve('config.yaml'));
  const out = await exec(runtime, [production, 'report', saved.id, '--project', s.root], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT } }); expect(out.stdout).toContain('报告');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } }); const remote: string[] = []; const errors: string[] = [];
    page.on('request', req => { if (/^https?:/.test(req.url())) remote.push(req.url()); }); page.on('pageerror', err => errors.push(err.message));
    await page.goto(pathToFileURL(saved.html).href); await expect(page.locator('h1').textContent()).resolves.toBe('验收卷宗');
    expect(await page.locator('script, svg, iframe, object').count()).toBe(0); expect(await page.evaluate('globalThis.pwned')).toBeUndefined();
    expect(await page.locator('body').innerText()).toContain(attack); expect(await page.locator('body').innerText()).toContain('无截图证据');
    expect(await page.locator('[data-network]').count()).toBe(3); expect(await page.locator('[data-network]').last().innerText()).toContain('/item'); expect(remote).toEqual([]); expect(errors).toEqual([]);
    await page.screenshot({ path: path.join(os.tmpdir(), 'task10-report-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 400, height: 800 }); expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'task10-report-mobile.png'), fullPage: true });
  } finally { await browser.close(); }
  await assertNoSecret(s.artifacts.resolve(`runs/${saved.id}`));
}, 30000);
it('第二case中断后resume只重跑incomplete，保留第一case提交与历史attempt', async () => {
  const s = await setup({ count: 2 });
  const child = fork(harness, ['run', '--project', s.root], { execPath: runtime, execArgv: [], silent: true, env: { ...process.env, CROSSCHECK_TEST_MODE: 'second-hang', CROSSCHECK_TEST_BASE: s.base, TEST_TOKEN: secret } });
  const [message] = await once(child, 'message'); expect(message).toBe('model-waiting'); child.send('SIGINT');
  expect((await once(child, 'exit'))[0]).toBe(2);
  const saved = await result(s); expect(saved.data.cases.map((c: any) => [c.complete, c.attempt])).toEqual([[true, 1], [false, 1]]);
  expect(s.counts().actions).toBe(1); expect((await launch(s, 'pass', ['--resume', saved.id])).code).toBe(0);
  expect(s.counts().actions).toBe(2); expect((await result(s)).data.cases.map((c: any) => c.attempt)).toEqual([1, 2]);
  expect(await s.artifacts.readBytes(`runs/${saved.id}/cases/M-TC-2/attempts/1/result.json`)).toBeDefined();
}, 30000);
it('init → reqs → review 人工确认 → plan → review 人工确认 → run 全链路', async () => {
  const { cliMain } = await import('../src/main');
  const { ReviewSession, approveProfileFile, approveAllClauses, approveAllCases, loadProfileOverview } = await import('@crosscheck/tui');
  const { scriptedModel } = await import('../../agent/src/testing/scripted-model');
  const base = await server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value: 'ok' })); });
  const root = await mkdtemp(path.join(os.tmpdir(), 'flow14-')); roots.push(root);
  const artifacts = new ArtifactStore(root);
  await artifacts.writeYaml('config.yaml', { models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:executor', reviewer: 'mock:reviewer' }, providers: { mock: { type: 'ollama' } }, defaultEnvironment: 'local', requirementsDocs: ['需求.md'], budget: { perCase: { steps: 20, tokens: 100000, minutes: 1 } } });
  await import('node:fs/promises').then((fs) => fs.writeFile(path.join(root, '需求.md'), '下单接口返回 ok\n'));
  const finish = (input: unknown) => ({ toolCalls: [{ name: 'finish', input }] });
  const extractor = scriptedModel([
    finish({ 'environments.yaml': { version: 1, environments: { local: { baseURL: base, healthcheck: `${base}/health`, reset: null } } } }),
    finish({ 'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } } }),
    finish({ 'api-catalog.yaml': { version: 1, operations: {} }, 'pages.yaml': { version: 1, pages: {} } }),
    finish({ 'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: {} } }),
    finish({ 'guardrails.yaml': { allowedHosts: [new URL(base).host] } }),
    finish([{ id: 'M-AC-1', text: '下单接口返回 ok', source: { file: '需求.md', line: 1, excerpt: '下单接口返回 ok' } }]),
  ]);
  const planner = scriptedModel([finish([{ id: 'M-TC-1', covers: ['M-AC-1'], fixtures: [], actor: 'guest', steps: ['POST /api/action', 'GET /item'], expectations: ['E1', 'E2'].map((id) => ({ id, text: '返回真实ok', evidence: ['network'] })) }])]);
  const dependencies = {
    modelOptions: { env: {}, factories: { ollama: ({ modelId }: { modelId: string }) => modelId === 'x' ? extractor : planner } },
    resilience: { retries: 0, baseDelayMs: 0 }, env: { CROSSCHECK_REVIEWER: '流程测试' },
    // 仅模型及人工键盘选择用测试替身；审核状态函数、落盘和门禁均使用真实实现。
    review: { isTTY: true, runReview: async (options: import('@crosscheck/tui').RunReviewOptions) => {
      const session = await ReviewSession.open(options.artifacts, options.reviewer);
      if (options.view === 'profile') for (const row of (await loadProfileOverview(session)).rows) await approveProfileFile(session, row.name);
      else if (options.view === 'clauses') expect(await approveAllClauses(session, options.module!)).toBe('已确认 1 条条款');
      else if (options.view === 'cases') expect(await approveAllCases(session, options.module!)).toBe('已确认 1 个用例');
      else throw new Error('测试未安排的审核视图');
      return 0;
    } },
  };
  const log = () => {};
  const command = (argv: string[]) => cliMain([...argv, '--project', root], { log, dependencies });
  expect(await command(['init'])).toBe(0);
  expect(await command(['reqs', '--module', 'M'])).toBe(0);
  expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
  expect(await command(['plan', '--module', 'M'])).toBe(2);
  expect(await command(['review', 'profile'])).toBe(0);
  expect(await command(['plan', '--module', 'M'])).toBe(2);
  expect(await command(['review', 'clauses', '--module', 'M'])).toBe(0);
  expect(await command(['plan', '--module', 'M'])).toBe(0);
  const env = { ...process.env, CROSSCHECK_TEST_MODE: 'pass', CROSSCHECK_TEST_BASE: base };
  await expect(exec(runtime, [harness, 'run', '--project', root], { env, timeout: 20000 })).rejects.toMatchObject({ code: 2 });
  expect(await command(['review', 'cases', '--module', 'M'])).toBe(0);
  const out = await exec(runtime, [harness, 'run', '--project', root], { env, timeout: 20000 });
  expect(out.stdout).toContain('PASS');
  const runIds = (await artifacts.list('runs')).sort();
  const runId = runIds.at(-1)!;
  const saved = JSON.parse((await artifacts.readBytes(`runs/${runId}/results.json`))!.toString());
  expect(saved.status).toBe('PASS');
  expect((await exec(runtime, [production, 'report', runId, '--project', root], { timeout: 20000 })).stdout).toContain('报告');
}, 60000);

it('生产 CLI help 可用且非 TTY review 拒绝 2', async () => {
  expect((await exec(runtime, [production, '--help'])).stdout).toContain('crosscheck review');
  await expect(exec(runtime, [production, 'review'])).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('交互式终端') });
});

it.each(['abort', 'SIGINT', 'SIGTERM'])('Windows等价IPC控制%s中断真实HTTP资源，await保存incomplete，resume新attempt', async control => {
  const s = await setup({ slow: true });
  const child = fork(harness, ['run', '--project', s.root], { execPath: runtime, execArgv: [], silent: true, env: { ...process.env, CROSSCHECK_TEST_BASE: s.base, TEST_TOKEN: secret } });
  let stdout = ''; child.stdout!.on('data', chunk => { stdout += chunk; });
  const started = Date.now();
  while (s.counts().active === 0 && Date.now() - started < 10000) await new Promise(resolve => setTimeout(resolve, 20));
  expect(s.counts().active).toBe(1); child.send(control); const [code] = await once(child, 'exit'); expect(code, stdout).toBe(2);
  expect(s.counts().active).toBe(0); const saved = await result(s); expect(saved.data.cases[0]).toMatchObject({ complete: false, status: 'BLOCKED', attempt: 1 });
  expect((await launch(s, 'invalid', ['--resume', saved.id])).code).toBe(2); expect((await result(s)).data.cases[0].attempt).toBe(2);
}, 30000);
