import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Approvals, ArtifactError, ArtifactStore, ConfigSchema, ProjectConfigSchema, readProfileFile } from '@crosscheck/core';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import { cliMain as realCliMain } from '../src/main';
const cliMain: typeof realCliMain = (argv, options = {}) => {
  const index = argv.indexOf('--project');
  return realCliMain(argv, { ...options, dependencies: { ...options.dependencies, userConfigHome: index >= 0 ? path.join(argv[index + 1]!, 'user') : undefined } });
};
import { CONFIG_TEMPLATE } from '../src/init';
import { InterruptedError, resolveModels, withInterrupt } from '../src/context';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const FILES = {
  'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:3000', healthcheck: 'http://localhost:3000/health', reset: null } } },
  'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } },
  'api-catalog.yaml': { version: 1, operations: {} }, 'pages.yaml': { version: 1, pages: {} },
  'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: {} },
  'guardrails.yaml': { allowedHosts: ['localhost:3000'] },
};
const finish = (names: (keyof typeof FILES)[]): ScriptStep => ({ toolCalls: [{ name: 'finish', input: Object.fromEntries(names.map((n) => [n, FILES[n]])) }] });
const STEPS = [finish(['environments.yaml']), finish(['auth.yaml']), finish(['api-catalog.yaml', 'pages.yaml']), finish(['data-model.yaml', 'fixtures.yaml']), finish(['guardrails.yaml'])];

async function project(withConfig: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cli-init-')); roots.push(root);
  const artifacts = new ArtifactStore(root);
  if (withConfig) { const notes = '# 项目笔记'; await artifacts.writeBytes('notes.md', Buffer.from(notes)); const approvals = Approvals.empty(); approvals.approve('notes', 'project', notes, '人工'); await approvals.save(artifacts); }
  await mkdir(path.join(root, 'user', '.crosscheck'), { recursive: true });
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' }, providers: { mock: { type: 'openai', baseURL: 'https://example.invalid/v1', apiKey: 'fixture-key' } } }));
  if (withConfig) await artifacts.writeYaml('config.yaml', {});
  return { root, artifacts };
}
const deps = (model: ReturnType<typeof scriptedModel>) => ({ modelOptions: { env: {}, factories: { openai: () => model } }, resilience: { retries: 0, baseDelayMs: 0 } });

it.each(['修改', '确认'] as const)('生成期间画像被人工%s时不覆盖', async (action) => {
  const { root, artifacts } = await project(true);
  await artifacts.writeYaml('system/auth.yaml', FILES['auth.yaml']);
  const before = await artifacts.readBytes('system/auth.yaml');
  const model = scriptedModel(STEPS); const generate = model.doGenerate.bind(model);
  let changed = false;
  vi.spyOn(model, 'doGenerate').mockImplementation(async (options) => {
    if (!changed) {
      changed = true;
      if (action === '修改') await artifacts.writeYaml('system/auth.yaml', { version: 1, actors: { human: { kind: 'anonymous' } } });
      else { const file = await readProfileFile(artifacts, 'auth.yaml'); if (!file.present || !file.ok) throw new Error('画像无效'); const approvals = await Approvals.load(artifacts); approvals.approve('profile', 'auth.yaml', file.value, '人工'); await approvals.save(artifacts); }
    }
    return generate(options);
  });
  expect(await cliMain(['profile', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(2);
  if (action === '确认') expect(await artifacts.readBytes('system/auth.yaml')).toEqual(before);
  else expect(await artifacts.readBytes('system/auth.yaml')).not.toEqual(before);
});

it('已确认画像作为上下文时密钥先脱敏', async () => {
  const { root, artifacts } = await project(true);
  const value = { version: 1, environments: { local: { baseURL: 'http://localhost:3000/fixture-key', healthcheck: 'http://localhost:3000/health', reset: null } } };
  await artifacts.writeYaml('system/environments.yaml', value);
  const file = await readProfileFile(artifacts, 'environments.yaml'); if (!file.present || !file.ok) throw new Error('画像无效');
  const approvals = await Approvals.load(artifacts); approvals.approve('profile', 'environments.yaml', file.value, '人工'); await approvals.save(artifacts);
  const model = scriptedModel(STEPS.slice(1));
  expect(await cliMain(['profile', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  expect(JSON.stringify(model.doGenerateCalls.map((call) => call.prompt))).not.toContain('fixture-key');
});

it('全部生成步骤失败且未写入文件时不声称已写入草稿', async () => {
  const { root, artifacts } = await project(true);
  const model = scriptedModel([]); const logs: string[] = [];
  expect(await cliMain(['profile', '--project', root], { log: (line) => logs.push(line), dependencies: deps(model) })).toBe(2);
  expect(await artifacts.list('system')).toEqual([]);
  expect(logs.join('\n')).not.toContain('画像草稿已写入');
  expect(logs.join('\n')).toContain('未写入');
});

it('全部画像已确认跳过时不声称写入草稿', async () => {
  const { root, artifacts } = await project(true);
  const approvals = await Approvals.load(artifacts);
  for (const [name, value] of Object.entries(FILES)) {
    await artifacts.writeYaml(`system/${name}`, value);
    const file = await readProfileFile(artifacts, name as keyof typeof FILES);
    if (!file.present || !file.ok) throw new Error('画像无效');
    approvals.approve('profile', name, file.value, '人工');
  }
  await approvals.save(artifacts);
  const logs: string[] = []; const model = scriptedModel([]);
  expect(await cliMain(['profile', '--project', root], { log: (line) => logs.push(line), dependencies: deps(model) })).toBe(0);
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(logs.join('\n')).not.toContain('画像草稿已写入');
  expect(logs.join('\n')).toContain('未写入');
});

it('前一步生成画像包含已知密钥时后续模型上下文不泄露', async () => {
  const { root } = await project(true);
  const env: ScriptStep = { toolCalls: [{ name: 'finish', input: { 'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:3000/fixture-key', healthcheck: 'http://localhost:3000/health', reset: null } } } } }] };
  const model = scriptedModel([env, ...STEPS.slice(1)]);
  expect(await cliMain(['profile', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  expect(JSON.stringify(model.doGenerateCalls.slice(1).map((call) => call.prompt))).not.toContain('fixture-key');
});

it('画像上下文里的未知 URL 凭据不得发送给模型', async () => {
  const { root, artifacts } = await project(true);
  const value = { version: 1, environments: { local: { baseURL: 'http://unknownuser:unknownpass@localhost:3000/?x=unknownquery', healthcheck: 'http://localhost:3000/health', reset: null } } };
  await artifacts.writeYaml('system/environments.yaml', value);
  const file = await readProfileFile(artifacts, 'environments.yaml'); if (!file.present || !file.ok) throw new Error('画像无效');
  const approvals = await Approvals.load(artifacts); approvals.approve('profile', file.name, file.value, '人工'); await approvals.save(artifacts);
  const model = scriptedModel(STEPS.slice(1));
  expect(await cliMain(['profile', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  const prompt = JSON.stringify(model.doGenerateCalls.map((call) => call.prompt));
  for (const secret of ['unknownuser', 'unknownpass', 'unknownquery']) expect(prompt).not.toContain(secret);
});

it.each(['笔记修改', '笔记撤销', '画像修改', '画像撤销'] as const)('生成期间%s后不写任何画像', async (action) => {
  const { root, artifacts } = await project(true);
  await artifacts.writeYaml('system/environments.yaml', FILES['environments.yaml']);
  const env = await readProfileFile(artifacts, 'environments.yaml'); if (!env.present || !env.ok) throw new Error('画像无效');
  const approvals = await Approvals.load(artifacts); approvals.approve('profile', env.name, env.value, '人工'); await approvals.save(artifacts);
  const model = scriptedModel(STEPS.slice(1)); const generate = model.doGenerate.bind(model); let changed = false;
  vi.spyOn(model, 'doGenerate').mockImplementation(async (options) => {
    if (!changed) {
      changed = true;
      if (action === '笔记修改') await artifacts.writeBytes('notes.md', Buffer.from('# 改动'));
      if (action === '画像修改') await artifacts.writeYaml('system/environments.yaml', { ...FILES['environments.yaml'], extra: 'changed' });
      if (action.endsWith('撤销')) { const latest = await Approvals.load(artifacts); latest.revoke(action.startsWith('笔记') ? 'notes' : 'profile', action.startsWith('笔记') ? 'project' : 'environments.yaml'); await latest.save(artifacts); }
    }
    return generate(options);
  });
  expect(await cliMain(['profile', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(2);
  expect(await artifacts.readBytes('system/auth.yaml')).toBeUndefined();
});

it('脱敏导致画像结构非法时不写非法文件', async () => {
  const { root, artifacts } = await project(true);
  const auth: ScriptStep = { toolCalls: [{ name: 'finish', input: { 'auth.yaml': { version: 1, actors: { token_user: { kind: 'anonymous' } } } } }] };
  const model = scriptedModel([STEPS[0]!, auth, ...STEPS.slice(2)]);
  const logs: string[] = [];
  expect(await cliMain(['profile', '--project', root], { log: (line) => logs.push(line), dependencies: deps(model) })).toBe(2);
  expect(await artifacts.readBytes('system/auth.yaml')).toBeUndefined();
  expect(logs.join('\n')).not.toContain('已生成 auth.yaml');
  expect(logs.join('\n')).toContain('auth.yaml 脱敏后格式不合法');
});

it('生成 7 份画像草稿且不写确认记录；重跑时保留已确认文件的原字节和确认记录', async () => {
  const { root, artifacts } = await project(true);
  const model = scriptedModel(STEPS); const out: string[] = [];
  const originalApprovals = await artifacts.readBytes('approvals.json');
  expect(await cliMain(['profile', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(0);
  for (const name of Object.keys(FILES)) expect(await readProfileFile(artifacts, name as keyof typeof FILES)).toMatchObject({ present: true, ok: true });
  expect(await artifacts.readBytes('approvals.json')).toEqual(originalApprovals);
  for (const call of model.doGenerateCalls) expect(JSON.stringify(call.prompt)).toContain('# 项目笔记');

  const env = await readProfileFile(artifacts, 'environments.yaml');
  if (!env.present || !env.ok) throw new Error('环境画像应合法');
  const approvals = await Approvals.load(artifacts);
  approvals.approve('profile', 'environments.yaml', env.value, '人工');
  await approvals.save(artifacts);
  const envBytes = await artifacts.readBytes('system/environments.yaml');
  const approvalBytes = await artifacts.readBytes('approvals.json');
  const second = scriptedModel(STEPS.slice(1));
  expect(await cliMain(['profile', '--project', root], { log: (s) => out.push(s), dependencies: deps(second) })).toBe(0);
  expect(second.doGenerateCalls).toHaveLength(4);
  expect(await artifacts.readBytes('system/environments.yaml')).toEqual(envBytes);
  expect(await artifacts.readBytes('approvals.json')).toEqual(approvalBytes);
  expect(out.join('\n')).toContain('跳过（已确认）');
});

it.each([false, true])('七画像已确认时 auth 一次读取故障（并发取消=%s）退出3，零模型且字节全不变', async (cancel) => {
  const { root, artifacts } = await project(true);
  const approvals = await Approvals.load(artifacts);
  for (const [name, value] of Object.entries(FILES)) {
    await artifacts.writeYaml(`system/${name}`, value);
    const file = await readProfileFile(artifacts, name as keyof typeof FILES);
    if (!file.present || !file.ok) throw new Error('画像应合法');
    approvals.approve('profile', name, file.value, '人工');
  }
  await approvals.save(artifacts);
  const paths = ['config.yaml', ...Object.keys(FILES).map((n) => `system/${n}`), 'approvals.json'];
  const before = await Promise.all(paths.map((p) => artifacts.readBytes(p)));
  const controller = new AbortController(); let failed = false;
  const read = ArtifactStore.prototype.readBytes;
  vi.spyOn(ArtifactStore.prototype, 'readBytes').mockImplementation(async function (this: ArtifactStore, rel) {
    if (rel === 'system/auth.yaml' && !failed) {
      failed = true;
      if (cancel) controller.abort();
      throw new ArtifactError('工件读取失败', { cause: Object.assign(new Error('auth 瞬时拒绝访问'), { code: 'EACCES' }) });
    }
    return read.call(this, rel);
  });
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { 'auth.yaml': { version: 1, actors: { replacement: { kind: 'anonymous' } } } } }] }]); const logs: string[] = [];
  const code = await cliMain(['profile', '--project', root], { log: (s) => logs.push(s), dependencies: deps(model), signal: controller.signal });
  expect(code).toBe(3);
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(await Promise.all(paths.map((p) => artifacts.readBytes(p)))).toEqual(before);
  expect(logs.join('\n')).toContain('工件读取失败');
});

it('草稿、过期确认与无效画像不能作为已确认上下文跳过', async () => {
  const { root, artifacts } = await project(true);
  await artifacts.writeYaml('system/environments.yaml', FILES['environments.yaml']);
  const env = await readProfileFile(artifacts, 'environments.yaml');
  if (!env.present || !env.ok) throw new Error('环境画像应合法');
  const approvals = await Approvals.load(artifacts);
  approvals.approve('profile', 'environments.yaml', env.value, '人工');
  approvals.approve('profile', 'auth.yaml', { invalid: true }, '人工');
  await approvals.save(artifacts);
  await artifacts.writeYaml('system/environments.yaml', { version: 1, environments: { local: { baseURL: 'http://localhost:4000' } } });
  await artifacts.writeYaml('system/auth.yaml', { invalid: true });
  await artifacts.writeYaml('system/pages.yaml', FILES['pages.yaml']);
  const model = scriptedModel(STEPS);
  expect(await cliMain(['profile', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  expect(model.doGenerateCalls).toHaveLength(5);
  const first = JSON.stringify(model.doGenerateCalls[0]!.prompt);
  expect(first).not.toContain('localhost:4000');
  expect(first).not.toContain('invalid');
  expect(await readProfileFile(artifacts, 'auth.yaml')).toMatchObject({ ok: true });
});

it('某步失败时退出 2，其余文件照常写入', async () => {
  const { root, artifacts } = await project(true);
  const bad: ScriptStep = { text: '不调用工具' };
  const model = scriptedModel([STEPS[0]!, bad, bad, bad, ...STEPS.slice(2)]);
  expect(await cliMain(['profile', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(2);
  expect(await readProfileFile(artifacts, 'auth.yaml')).toEqual({ name: 'auth.yaml', present: false });
  expect(await readProfileFile(artifacts, 'guardrails.yaml')).toMatchObject({ ok: true });
});

it.each([false, true])('预先取消时不写模板或草稿、不解析模型（已有配置：%s）', async (withConfig) => {
  const { root, artifacts } = await project(withConfig);
  const before = await artifacts.readBytes('config.yaml');
  const model = scriptedModel([]);
  const factories = { openai: vi.fn(() => model) };
  expect(await cliMain(['profile', '--project', root], {
    log: () => {}, signal: AbortSignal.abort(), dependencies: { modelOptions: { env: {}, factories } },
  })).toBe(2);
  expect(await artifacts.readBytes('config.yaml')).toEqual(before);
  expect(await artifacts.list('system')).toEqual([]);
  expect(factories.openai).not.toHaveBeenCalled();
  expect(model.doGenerateCalls).toHaveLength(0);
});

it('扫描后取消不再解析模型或写入草稿', async () => {
  const { root, artifacts } = await project(true);
  const controller = new AbortController();
  const factory = vi.fn(() => scriptedModel([]));
  expect(await cliMain(['profile', '--project', root], {
    log: () => controller.abort(), signal: controller.signal,
    dependencies: { modelOptions: { env: {}, factories: { openai: factory } } },
  })).toBe(2);
  expect(factory).not.toHaveBeenCalled();
  expect(await artifacts.list('system')).toEqual([]);
});

it('模型执行中取消退出 2，不再调用后续模型或创建草稿', async () => {
  const { root, artifacts } = await project(true);
  const controller = new AbortController();
  const model = scriptedModel([]);
  vi.spyOn(model, 'doGenerate').mockImplementation(async (options) => {
    controller.abort();
    options.abortSignal!.throwIfAborted();
    throw new Error('取消应阻止继续执行');
  });
  expect(await cliMain(['profile', '--project', root], { log: () => {}, dependencies: deps(model), signal: controller.signal })).toBe(2);
  expect(model.doGenerate).toHaveBeenCalledTimes(1);
  expect(await artifacts.list('system')).toEqual([]);
});

it('T6 Minor：第1步已合成但第2步中断时丢弃未落盘草稿，退出2且保留既有写入', async () => {
  const { root, artifacts } = await project(true);
  await artifacts.writeYaml('system/pages.yaml', FILES['pages.yaml']);
  const before = await artifacts.readBytes('system/pages.yaml');
  const controller = new AbortController();
  const model = scriptedModel([STEPS[0]!]);
  const generate = model.doGenerate.bind(model);
  vi.spyOn(model, 'doGenerate').mockImplementation(async (options) => {
    if (model.doGenerateCalls.length === 1) { controller.abort(); options.abortSignal!.throwIfAborted(); }
    return generate(options);
  });
  expect(await cliMain(['profile', '--project', root], { log: () => {}, dependencies: deps(model), signal: controller.signal })).toBe(2);
  expect(model.doGenerate).toHaveBeenCalledTimes(2);
  expect(await artifacts.readBytes('system/environments.yaml')).toBeUndefined();
  expect(await artifacts.readBytes('system/pages.yaml')).toEqual(before);
  expect(await artifacts.list('system')).toEqual(['pages.yaml']);
  expect(await artifacts.readBytes('approvals.json')).toBeDefined();
});

it.each(['environments.yaml', 'guardrails.yaml'])('写入 %s 期间取消保留已完整写入文件，退出 2 并停止后续写入', async (cancelAt) => {
  const { root, artifacts } = await project(true);
  const controller = new AbortController();
  const original = ArtifactStore.prototype.writeYaml;
  vi.spyOn(ArtifactStore.prototype, 'writeYaml').mockImplementation(async function (this: ArtifactStore, rel, value) {
    await original.call(this, rel, value);
    if (rel === `system/${cancelAt}`) controller.abort();
  });
  expect(await cliMain(['profile', '--project', root], { log: () => {}, dependencies: deps(scriptedModel(STEPS)), signal: controller.signal })).toBe(2);
  expect(await readProfileFile(artifacts, 'environments.yaml')).toMatchObject({ ok: true });
  if (cancelAt === 'environments.yaml') expect(await artifacts.list('system')).toEqual(['environments.yaml']);
  else expect(await artifacts.list('system')).toHaveLength(7);
  expect(await artifacts.readBytes('approvals.json')).toBeDefined();
});

it('配置缺密钥是宿主错误，保留具体诊断', async () => {
  const { root, artifacts } = await project(true);
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'openai:x', planner: 'openai:x', executor: 'openai:x', reviewer: 'openai:x' }, providers: { openai: { type: 'openai', baseURL: 'https://example.invalid/v1' } } }));
  const out: string[] = [];
  expect(await cliMain(['profile', '--project', root], { log: (s) => out.push(s), dependencies: { env: {} } })).toBe(3);
  expect(out.join('\n')).toContain('apiKey');
  expect(await artifacts.list('system')).toEqual([]);
});

it('真实草稿写入失败即使信号同时取消也退出 3，保留已写文件', async () => {
  const { root, artifacts } = await project(true);
  const controller = new AbortController();
  const original = ArtifactStore.prototype.writeYaml;
  vi.spyOn(ArtifactStore.prototype, 'writeYaml').mockImplementation(async function (this: ArtifactStore, rel, value) {
    if (rel === 'system/auth.yaml') await mkdir(this.resolve(rel), { recursive: true });
    try { await original.call(this, rel, value); }
    catch (error) { controller.abort(); throw error; }
  });
  const out: string[] = [];
  expect(await cliMain(['profile', '--project', root], { log: (s) => out.push(s), dependencies: deps(scriptedModel(STEPS)), signal: controller.signal })).toBe(3);
  expect(out.join('\n')).toContain('宿主错误');
  expect(out.join('\n')).toContain('工件写入失败');
  expect(await readProfileFile(artifacts, 'environments.yaml')).toMatchObject({ ok: true });
  expect(await artifacts.readBytes('approvals.json')).toBeDefined();
});
