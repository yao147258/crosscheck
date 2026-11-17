import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Approvals, ArtifactStore, ClauseSchema, TestCaseSchema, loadProfile } from '@crosscheck/core';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import { cliMain as realCliMain } from '../src/main';
const cliMain: typeof realCliMain = (argv, options = {}) => {
  const index = argv.indexOf('--project');
  return realCliMain(argv, { ...options, dependencies: { ...options.dependencies, userConfigHome: index >= 0 ? path.join(argv[index + 1]!, 'user') : undefined } });
};

vi.mock('node:fs/promises', { spy: true });

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const finish = (input: unknown): ScriptStep => ({ toolCalls: [{ name: 'finish', input }] });
const doc = '用户可以下单\n订单列表按时间倒序\n';
const c1 = ClauseSchema.parse({ id: 'M-AC-1', text: '用户可以下单', source: { file: 'docs/需求.md', line: 1, excerpt: '用户可以下单' } });
const c2 = ClauseSchema.parse({ id: 'M-AC-2', text: '订单列表倒序', source: { file: 'docs/需求.md', line: 2, excerpt: '订单列表按时间倒序' } });
const case1 = TestCaseSchema.parse({ id: 'M-TC-1', covers: ['M-AC-1'], fixtures: [], actor: 'guest', steps: ['下单'], expectations: [{ id: 'E1', text: '返回订单号', evidence: ['network'] }] });
const PROFILE = {
  'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:3000', healthcheck: 'http://localhost:3000/health', reset: null } } },
  'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } },
  'api-catalog.yaml': { version: 1, operations: {} }, 'pages.yaml': { version: 1, pages: {} },
  'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: {} },
  'guardrails.yaml': { allowedHosts: ['localhost:3000'] },
};

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cli-rp-'));
  roots.push(root);
  return root;
}
async function project(docs: string[] = ['docs/需求.md']) {
  const root = await tempRoot();
  const artifacts = new ArtifactStore(root);
  await mkdir(path.join(root, 'user', '.crosscheck'), { recursive: true });
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' }, providers: { mock: { type: 'ollama' } } }));
  await artifacts.writeYaml('config.yaml', { requirementsDocs: docs });
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/需求.md'), doc);
  return { root, artifacts };
}
const deps = (model: ReturnType<typeof scriptedModel>) => ({ modelOptions: { env: {}, factories: { ollama: () => model } }, resilience: { retries: 0, baseDelayMs: 0 } });
async function approveProfile(artifacts: ArtifactStore, approvals: Approvals) {
  for (const [name, value] of Object.entries(PROFILE)) await artifacts.writeYaml(`system/${name}`, value);
  for (const [name, value] of Object.entries(await loadProfile(artifacts))) approvals.approve('profile', name, value, '人工');
}
async function plannableProject() {
  const projectState = await project();
  const approvals = Approvals.empty();
  await approveProfile(projectState.artifacts, approvals);
  await projectState.artifacts.saveClauses('M', [c1, c2]);
  approvals.approve('clause', c1.id, c1, '人工');
  await approvals.save(projectState.artifacts);
  return { ...projectState, approvals };
}
function userMessage(model: ReturnType<typeof scriptedModel>) {
  const message = model.doGenerateCalls[0]!.prompt.find((entry) => entry.role === 'user')!;
  return JSON.parse((message.content as Array<{ type: string; text: string }>).find((part) => part.type === 'text')!.text);
}

it('reqs 初次写草稿且不写确认记录，重跑仅保留真正已确认条款', async () => {
  const { root, artifacts } = await project();
  const first = scriptedModel([finish([c1, c2])]);
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: () => {}, dependencies: deps(first) })).toBe(0);
  expect(await artifacts.loadClauses('M')).toEqual([c1, c2]);
  expect(await artifacts.readBytes('approvals.json')).toBeUndefined();

  const approvals = Approvals.empty();
  approvals.approve('clause', c1.id, c1, '人工');
  approvals.approve('clause', c2.id, c2, '人工');
  await approvals.save(artifacts);
  await artifacts.saveClauses('M', [c1, { ...c2, text: '失效确认不应作为 known' }, { ...c1, id: 'M-AC-9', text: '旧草稿应被替换' }]);
  const approvalBytes = await artifacts.readBytes('approvals.json');
  const replacement = { ...c2, text: '订单列表按时间倒序排列' };
  const second = scriptedModel([finish([replacement])]);
  const out: string[] = [];
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(second) })).toBe(0);
  expect(await artifacts.loadClauses('M')).toEqual([c1, replacement]);
  expect(userMessage(second).known).toEqual([{ id: c1.id, text: c1.text, source: c1.source }]);
  expect(await artifacts.readBytes('approvals.json')).toEqual(approvalBytes);
  expect(out.join('\n')).toContain('保留已确认 1 条');
});

it('reqs 提炼失败退出 2，原条款文件字节保持不变', async () => {
  const { root, artifacts } = await project();
  await artifacts.saveClauses('M', [c1]);
  const before = await artifacts.readBytes('requirements/M.yaml');
  const bad: ScriptStep = { text: '无工具' };
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: () => {}, dependencies: deps(scriptedModel([bad, bad, bad])) })).toBe(2);
  expect(await artifacts.readBytes('requirements/M.yaml')).toEqual(before);
});

it('reqs 空文档列表是门禁，缺失文档和父目录逃逸是宿主错误', async () => {
  for (const [docs, code, diagnostic] of [[[], 2, 'requirementsDocs 为空'], [['missing.md'], 3, '需求文档'], [['../外部.md'], 3, '路径']] as const) {
    const { root, artifacts } = await project([...docs]);
    const model = scriptedModel([]);
    const out: string[] = [];
    expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(code);
    expect(out.join('\n')).toContain(diagnostic);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await artifacts.list('requirements')).toEqual([]);
  }
});

it('reqs 拒绝真实目录链接逃逸，外部需求不进入模型', async () => {
  const { root, artifacts } = await project(['link/需求.md']);
  const outside = await tempRoot();
  await writeFile(path.join(outside, '需求.md'), '外部秘密');
  await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const model = scriptedModel([]);
  const out: string[] = [];
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(3);
  expect(out.join('\n')).toMatch(/符号链接|联接/);
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(await artifacts.list('requirements')).toEqual([]);
});

it.each(['.env', 'docs/credentials.json'])('reqs 不把凭证文件 %s 发送给模型', async (file) => {
  const { root } = await project([file]);
  await writeFile(path.join(root, file), '私密凭证');
  const model = scriptedModel([]);
  const out: string[] = [];
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(3);
  expect(out.join('\n')).toContain('不允许读取');
  expect(model.doGenerateCalls).toHaveLength(0);
});

it.each(['单文件', '总量'])('reqs 保留既有文档大小限额（%s），超限不调用模型', async (kind) => {
  const files = kind === '单文件' ? ['large.md'] : ['a.md', 'b.md', 'c.md'];
  const { root } = await project(files);
  for (const file of files) await writeFile(path.join(root, file), Buffer.alloc(1024 * 1024 + (kind === '单文件' ? 1 : 0), 'a'));
  const model = scriptedModel([]);
  const out: string[] = [];
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(3);
  expect(out.join('\n')).toMatch(/大小|限制/);
  expect(model.doGenerateCalls).toHaveLength(0);
});

it('reqs 将点路径和反斜杠规范为可校验的文档来源', async () => {
  const { root, artifacts } = await project(['./docs\\需求.md']);
  const model = scriptedModel([finish([c1])]);
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  expect(await artifacts.loadClauses('M')).toEqual([c1]);
  expect(userMessage(model).documents).toEqual([{ file: 'docs/需求.md', text: doc }]);
});

it.each(['缺失', '未确认', '失效', '无效'])('plan 画像%s时退出 2，不调用模型也不写用例', async (kind) => {
  const { root, artifacts } = await project();
  const approvals = Approvals.empty();
  if (kind !== '缺失') await approveProfile(artifacts, approvals);
  if (kind === '未确认') approvals.revoke('profile', 'auth.yaml');
  if (kind === '失效') await artifacts.writeYaml('system/auth.yaml', { version: 1, actors: { other: { kind: 'anonymous' } } });
  if (kind === '无效') await artifacts.writeYaml('system/auth.yaml', { invalid: true });
  await approvals.save(artifacts);
  await artifacts.saveClauses('M', [c1]);
  const model = scriptedModel([]);
  const out: string[] = [];
  expect(await cliMain(['plan', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(2);
  expect(out.join('\n')).toContain('画像');
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(await artifacts.list('cases')).toEqual([]);
});

it('plan 无已确认 active 条款时门禁退出，不解析模型', async () => {
  const { root, artifacts, approvals } = await plannableProject();
  const inactive = { ...c1, status: 'unclear' as const };
  await artifacts.saveClauses('M', [inactive, c2]);
  approvals.approve('clause', inactive.id, inactive, '人工');
  await approvals.save(artifacts);
  const factory = vi.fn(() => scriptedModel([]));
  expect(await cliMain(['plan', '--module', 'M', '--project', root], { log: () => {}, dependencies: { modelOptions: { env: {}, factories: { ollama: factory } } } })).toBe(2);
  expect(factory).not.toHaveBeenCalled();
  expect(await artifacts.list('cases')).toEqual([]);
});

it('plan 只用已确认 active 条款，保留绑定确认的用例、替换其余草稿并报告覆盖率', async () => {
  const { root, artifacts, approvals } = await plannableProject();
  const inactive = { ...c1, id: 'M-AC-3', status: 'unclear' as const, text: '非 active 不应参与生成' };
  const stale = { ...c1, id: 'M-AC-4', text: '已修改的过期条款' };
  await artifacts.saveClauses('M', [c1, c2, inactive, stale]);
  approvals.approve('clause', inactive.id, inactive, '人工');
  approvals.approve('clause', stale.id, { ...stale, text: '修改前' }, '人工');
  const confirmed = { ...case1, id: 'M-TC-5', steps: ['人工确认的下单步骤'] };
  await artifacts.saveCases('M', [confirmed, { ...case1, id: 'M-TC-9' }]);
  approvals.approveCase(confirmed, [c1, c2], '人工');
  await approvals.save(artifacts);
  const before = await artifacts.readBytes('approvals.json');
  const model = scriptedModel([finish([case1])]);
  const out: string[] = [];
  expect(await cliMain(['plan', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(0);
  expect(await artifacts.loadCases('M')).toEqual([case1, confirmed]);
  expect(userMessage(model).clauses).toEqual([{ id: c1.id, text: c1.text, source: c1.source }]);
  expect(userMessage(model).knownCases).toEqual([confirmed]);
  expect(await artifacts.readBytes('approvals.json')).toEqual(before);
  expect(out.join('\n')).toContain('条款覆盖 1/1');
});

it('plan 使用跨模块全部覆盖条款判断用例确认，覆盖内容改动后不再保留旧用例', async () => {
  const { root, artifacts, approvals } = await plannableProject();
  const external = { ...c2, id: 'N-AC-1' };
  await artifacts.saveClauses('N', [external]);
  const bound = { ...case1, id: 'M-TC-5', covers: [c1.id, external.id] };
  await artifacts.saveCases('M', [bound]);
  approvals.approveCase(bound, [c1, external], '人工');
  await approvals.save(artifacts);
  const model = scriptedModel([finish([])]);
  expect(await cliMain(['plan', '--module', 'M', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  expect(await artifacts.loadCases('M')).toEqual([bound]);
  expect(userMessage(model).knownCases).toEqual([bound]);
  await artifacts.saveClauses('N', [{ ...external, text: '已改动的覆盖条款' }]);
  const next = scriptedModel([finish([case1])]);
  expect(await cliMain(['plan', '--module', 'M', '--project', root], { log: () => {}, dependencies: deps(next) })).toBe(0);
  expect(await artifacts.loadCases('M')).toEqual([case1]);
  expect(userMessage(next).knownCases).toEqual([]);
});

it('plan 模型输出失败不修改用例文件；成功时报告未覆盖条款', async () => {
  const { root, artifacts, approvals } = await plannableProject();
  approvals.approve('clause', c2.id, c2, '人工');
  await approvals.save(artifacts);
  await artifacts.saveCases('M', [case1]);
  const before = await artifacts.readBytes('cases/M.yaml');
  const invalid = finish([{ ...case1, covers: ['N-AC-1'] }]);
  expect(await cliMain(['plan', '--module', 'M', '--project', root], { log: () => {}, dependencies: deps(scriptedModel([invalid, invalid, invalid])) })).toBe(2);
  expect(await artifacts.readBytes('cases/M.yaml')).toEqual(before);
  const out: string[] = [];
  expect(await cliMain(['plan', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(scriptedModel([finish([case1])])) })).toBe(0);
  expect(out.join('\n')).toContain('条款覆盖 1/2');
  expect(out.join('\n')).toContain('未覆盖条款：M-AC-2');
});

it.each(['reqs', 'plan'] as const)('%s 预先取消不读写工件、不解析模型', async (command) => {
  const { root, artifacts } = await plannableProject();
  await artifacts.saveCases('M', [case1]);
  const clauses = await artifacts.readBytes('requirements/M.yaml');
  const cases = await artifacts.readBytes('cases/M.yaml');
  const approvals = await artifacts.readBytes('approvals.json');
  const factory = vi.fn(() => scriptedModel([]));
  const load = vi.spyOn(ArtifactStore.prototype, 'loadConfig');
  expect(await cliMain([command, '--module', 'M', '--project', root], { log: () => {}, signal: AbortSignal.abort(), dependencies: { modelOptions: { env: {}, factories: { ollama: factory } } } })).toBe(2);
  expect(load).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled();
  expect(await artifacts.readBytes('requirements/M.yaml')).toEqual(clauses);
  expect(await artifacts.readBytes('cases/M.yaml')).toEqual(cases);
  expect(await artifacts.readBytes('approvals.json')).toEqual(approvals);
});

it.each(['reqs', 'plan'] as const)('%s 读取后取消不解析模型也不写草稿', async (command) => {
  const { root, artifacts } = await plannableProject();
  const before = await artifacts.readBytes('requirements/M.yaml');
  const controller = new AbortController();
  const original = ArtifactStore.prototype.loadClauses;
  vi.spyOn(ArtifactStore.prototype, 'loadClauses').mockImplementation(async function (this: ArtifactStore, module) {
    const clauses = await original.call(this, module);
    controller.abort();
    return clauses;
  });
  const factory = vi.fn(() => scriptedModel([]));
  expect(await cliMain([command, '--module', 'M', '--project', root], { log: () => {}, signal: controller.signal, dependencies: { modelOptions: { env: {}, factories: { ollama: factory } } } })).toBe(2);
  expect(factory).not.toHaveBeenCalled();
  expect(await artifacts.readBytes('requirements/M.yaml')).toEqual(before);
  expect(await artifacts.list('cases')).toEqual([]);
});

it.each(['reqs', 'plan'] as const)('%s 模型返回时取消不写草稿', async (command) => {
  const { root, artifacts } = await plannableProject();
  const before = await artifacts.readBytes('requirements/M.yaml');
  const controller = new AbortController();
  const model = scriptedModel([finish(command === 'reqs' ? [c2] : [case1])]);
  const generate = model.doGenerate.bind(model);
  vi.spyOn(model, 'doGenerate').mockImplementation(async (options) => {
    const result = await generate(options);
    controller.abort();
    return result;
  });
  expect(await cliMain([command, '--module', 'M', '--project', root], { log: () => {}, signal: controller.signal, dependencies: deps(model) })).toBe(2);
  expect(await artifacts.readBytes('requirements/M.yaml')).toEqual(before);
  expect(await artifacts.list('cases')).toEqual([]);
});

it.each(['reqs', 'plan'] as const)('%s 真实写入错误与取消同时发生仍退出 3', async (command) => {
  const { root, artifacts } = await plannableProject();
  const rel = command === 'reqs' ? 'requirements/M.yaml' : 'cases/M.yaml';
  const controller = new AbortController();
  const original = ArtifactStore.prototype.writeYaml;
  vi.spyOn(ArtifactStore.prototype, 'writeYaml').mockImplementation(async function (this: ArtifactStore, file, value) {
    if (file === rel) {
      await rm(this.resolve(rel), { force: true });
      await mkdir(this.resolve(rel), { recursive: true });
    }
    try { await original.call(this, file, value); }
    catch (error) { controller.abort(); throw error; }
  });
  const model = scriptedModel([finish(command === 'reqs' ? [c2] : [case1])]);
  const out: string[] = [];
  expect(await cliMain([command, '--module', 'M', '--project', root], { log: (s) => out.push(s), signal: controller.signal, dependencies: deps(model) })).toBe(3);
  expect(out.join('\n')).toContain('工件写入失败');
});

it('reqs 文档读取真实失败与取消同时发生仍退出 3', async () => {
  const { root, artifacts } = await project();
  const controller = new AbortController();
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).lstat;
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]).endsWith(path.join('docs', '需求.md'))) {
      controller.abort();
      throw Object.assign(new Error('真实读取故障'), { code: 'EACCES' });
    }
    return original(...args);
  });
  const model = scriptedModel([]);
  const out: string[] = [];
  const code = await cliMain(['reqs', '--module', 'M', '--project', root], { log: (s) => out.push(s), signal: controller.signal, dependencies: deps(model) });
  expect(code).toBe(3);
  expect(out.join('\n')).toContain('读取项目文件失败');
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(await artifacts.list('requirements')).toEqual([]);
});

it('plan 真实画像读取错误不被当成画像门禁', async () => {
  const { root, artifacts } = await plannableProject();
  await rm(artifacts.resolve('system/auth.yaml'));
  await mkdir(artifacts.resolve('system/auth.yaml'));
  const model = scriptedModel([]);
  const out: string[] = [];
  expect(await cliMain(['plan', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(3);
  expect(out.join('\n')).toContain('工件读取失败');
  expect(model.doGenerateCalls).toHaveLength(0);
});
