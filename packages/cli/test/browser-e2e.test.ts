import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Approvals, ArtifactStore, ClauseSchema, EvidenceRecordSchema, RunResultSchema, TestCaseSchema, loadProfile } from '@crosscheck/core';
import { chromium } from 'playwright';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const harness = path.join(repo, 'packages/cli/dist/test-harness.js');
const production = path.join(repo, 'packages/cli/dist/index.js');
const secret = 'BROWSER_CLI_CREDENTIAL_9417';
const executorSentinel = 'EXECUTOR_ONLY_SENTINEL_1001';
const attack = '</script><svg onload="globalThis.pwned=1">页面不可信文本</svg>';
const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  closers.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function setup(images: boolean) {
  let submitted = 0, pageRequests = 0;
  // 独立端口不列入 HTTP allowedHosts，证明普通页面请求没有被误当作网络隔离目标。
  const asset = await serve((_req, res) => { pageRequests++; res.setHeader('Access-Control-Allow-Origin', '*'); res.end('正常页面请求'); });
  const base = await serve((req, res) => {
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{}'); return; }
    if (req.url === '/save') {
      let body = '';
      req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (new URLSearchParams(body).get('password') === secret) submitted++;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<p id="result">保存成功 CLI_BROWSER_DONE</p><pre>${attack.replaceAll('<', '&lt;')}</pre>`);
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<form action="/save" method="post"><label>密码<input name="password" type="password" oninput="console.log('password='+this.value)"></label><button>保存</button></form><p id="page-request">等待请求</p><script>fetch(${JSON.stringify(asset)}).then(r=>r.text()).then(t=>document.querySelector('#page-request').textContent=t);</script>`);
  });
  const root = await mkdtemp(path.join(tmpdir(), 'browser-cli-')); roots.push(root);
  const artifacts = new ArtifactStore(root);
  const userHome = path.join(root, 'user'); await mkdir(path.join(userHome, '.crosscheck'), { recursive: true });
  await writeFile(path.join(userHome, '.crosscheck', 'config.yaml'), JSON.stringify({
    models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:executor', reviewer: 'mock:reviewer' },
    providers: { mock: { type: 'ollama' } }, capabilities: { 'mock:executor': { images: true }, 'mock:reviewer': { images } },
  }));
  await artifacts.writeYaml('config.yaml', { defaultEnvironment: 'local', budget: { perCase: { steps: 20, tokens: 100000, minutes: 1 } } });
  const files = {
    'environments.yaml': { version: 1, environments: { local: { baseURL: base, healthcheck: `${base}/health`, reset: null } } },
    'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } },
    'api-catalog.yaml': { version: 1, operations: {} }, 'pages.yaml': { version: 1, pages: {} },
    'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: {} },
    'guardrails.yaml': { allowedHosts: [new URL(base).host], screenshotMasks: ['[data-private]'] },
  };
  for (const [name, value] of Object.entries(files)) await artifacts.writeYaml(`system/${name}`, value);
  const clause = ClauseSchema.parse({ id: 'M-AC-1', text: `填写并保存表单后显示成功。${attack}`, source: { file: '需求.md', line: 1, excerpt: '填写并保存表单后显示成功' } });
  const tc = TestCaseSchema.parse({ id: 'M-TC-1', covers: [clause.id], actor: 'guest', steps: ['导航表单', '填写密码环境变量', '点击保存', '观察成功页面'], expectations: ['E1', 'E2'].map(id => ({ id, text: '页面显示保存成功，不依据已脱敏控件值推测输入', evidence: ['screenshot', 'dom'] })) });
  await artifacts.saveClauses('M', [clause]); await artifacts.saveCases('M', [tc]);
  const approvals = Approvals.empty();
  for (const [name, value] of Object.entries(await loadProfile(artifacts))) approvals.approve('profile', name, value, '测试人工');
  approvals.approve('clause', clause.id, clause, '测试人工'); approvals.approveCase(tc, [clause], '测试人工'); await approvals.save(artifacts);
  return { artifacts, root, base, counts: () => ({ submitted, pageRequests }) };
}
async function assertNoSecret(directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await assertNoSecret(file);
    else expect((await readFile(file)).includes(Buffer.from(secret)), file).toBe(false);
  }
}
type Receipt = { role: string; images: { id: string; digest: string }[]; domIds: string[]; blind: boolean };

describe.skipIf(process.env.CROSSCHECK_REAL_BROWSER !== '1')('构建 CLI 真实 Chromium 端到端（无外部模型）', () => {
  beforeAll(async () => {
    await exec(process.execPath, ['scripts/build.mjs'], { cwd: repo });
    await exec(process.execPath, ['scripts/build.mjs', '--harness'], { cwd: repo });
  });
  it.each([['browser-pass', 'PASS', 0], ['browser-disputed', 'DISPUTED', 2], ['browser-no-images', 'BLOCKED', 2]] as const)('%s：真实动作、图片/DOM附件、三报告与脱敏一致', async (mode, status, code) => {
    const s = await setup(mode !== 'browser-no-images');
    let actualCode = 0, stdout = '';
    try {
      stdout = (await exec(process.execPath, [harness, 'run', '--project', s.root], {
        cwd: repo, env: { ...process.env, USERPROFILE: path.join(s.root, 'user'), HOME: path.join(s.root, 'user'), CROSSCHECK_TEST_MODE: mode, CROSSCHECK_TEST_BASE: s.base, BROWSER_PASSWORD: secret }, timeout: 20000,
      })).stdout;
    } catch (error: any) {
      if (typeof error.code !== 'number') throw error;
      actualCode = error.code; stdout = error.stdout;
    }
    expect(actualCode, stdout).toBe(code);
    const runId = (await s.artifacts.list('runs'))[0]!;
    const result = await s.artifacts.readJson(`runs/${runId}/results.json`, RunResultSchema);
    expect(result?.status, stdout).toBe(status);
    expect(result?.cases[0]).toMatchObject({ status, complete: true });
    expect(s.counts().submitted).toBe(1); expect(s.counts().pageRequests).toBeGreaterThan(0);
    const attempt = `runs/${runId}/cases/M-TC-1/attempts/1`;
    const records = (await s.artifacts.readJson(`${attempt}/evidence/index.json`, EvidenceRecordSchema.array()))!;
    const index = new Map(records.map(record => [record.id, record]));
    for (const record of records) {
      expect(record).toMatchObject({ runId, caseId: 'M-TC-1', attempt: 1, redacted: true });
      const bytes = (await s.artifacts.readBytes(record.path))!;
      expect(digest(bytes)).toBe(record.digest);
      if (record.type === 'screenshot') expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    const receipts: Receipt[] = stdout.split(/\r?\n/).filter(line => line.startsWith('BROWSER_RECEIPT ')).map(line => JSON.parse(line.slice('BROWSER_RECEIPT '.length)));
    for (const role of ['executor', 'reviewer']) {
      const receipt = receipts.find(r => r.role === role)!;
      expect(receipt, stdout).toBeDefined(); expect(receipt.blind).toBe(true);
      expect(receipt.domIds.length).toBeGreaterThan(0);
      for (const id of receipt.domIds) expect(index.get(id)?.type).toBe('dom');
      if (role === 'reviewer' && mode === 'browser-no-images') expect(receipt.images).toEqual([]);
      else {
        expect(receipt.images.length).toBeGreaterThan(0);
        for (const image of receipt.images) expect(index.get(image.id)).toMatchObject({ type: 'screenshot', digest: image.digest });
      }
    }
    if (status !== 'BLOCKED') {
      for (const expectation of result!.cases[0]!.expectations) {
        for (const judgement of [expectation.executor, expectation.reviewer]) {
          expect(judgement).not.toBeNull();
          expect(new Set(judgement!.evidenceIds.map(id => index.get(id)?.type))).toEqual(new Set(['screenshot', 'dom']));
        }
      }
    }
    const trace = (await s.artifacts.readBytes(`${attempt}/trace.jsonl`))!.toString();
    const actions = trace.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.action?.type === 'browser_action');
    expect(actions.map(event => event.action.input.kind === 'secretRef' ? 'fill' : event.action.input.value?.kind)).toEqual(['navigate', 'fill', 'click', 'observe']);
    expect(trace).toContain('BROWSER_PASSWORD');
    const xml = (await s.artifacts.readBytes(`runs/${runId}/junit.xml`))!.toString();
    expect(xml).toContain(`name="status" value="${status}"`);
    expect(xml.includes('<skipped')).toBe(status !== 'PASS'); expect(xml).not.toContain('<failure');
    const htmlPath = s.artifacts.resolve(`runs/${runId}/report/index.html`);
    const html = await readFile(htmlPath, 'utf8');
    expect(html).toContain(status); expect(html).toContain('data:image/png;base64,');
    expect(html).not.toMatch(/<script|<svg/i);
    await assertNoSecret(s.root);
    // provider 收据不包含执行器结论；已有 runner 测试负责取消/恢复与无图 fallback 的细粒度分支。
    expect(JSON.stringify(receipts)).not.toContain(executorSentinel);
    if (mode === 'browser-pass') {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage(); const external: string[] = [];
        page.on('request', req => { if (/^https?:/.test(req.url())) external.push(req.url()); });
        await page.goto(pathToFileURL(htmlPath).href);
        expect(await page.locator('body').innerText()).toContain(attack);
        expect(await page.locator('img').count()).toBeGreaterThan(0);
        expect(await page.locator('img').evaluateAll(images => images.every(img => 'naturalWidth' in img && 'complete' in img && img.complete && Number(img.naturalWidth) > 0))).toBe(true);
        expect(await page.evaluate('globalThis.pwned')).toBeUndefined(); expect(external).toEqual([]);
      } finally { await browser.close(); }
      const rebuilt = await exec(process.execPath, [production, 'report', runId, '--project', s.root], { cwd: repo, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT } });
      expect(rebuilt.stdout).toContain('报告'); expect(await readFile(htmlPath, 'utf8')).toBe(html);
    }
  });
});
