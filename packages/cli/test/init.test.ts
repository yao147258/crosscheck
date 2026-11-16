import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Approvals, ArtifactError, ArtifactStore, ConfigSchema, readProfileFile } from '@crosscheck/core';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import { cliMain } from '../src/main';
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
  if (withConfig) await artifacts.writeYaml('config.yaml', { models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' }, providers: { mock: { type: 'ollama' } } });
  return { root, artifacts };
}
const deps = (model: ReturnType<typeof scriptedModel>) => ({ modelOptions: { env: {}, factories: { ollama: () => model } }, resilience: { retries: 0, baseDelayMs: 0 } });

it('没有 config.yaml 时写入合法模板并退出 2，不调用模型', async () => {
  const { root, artifacts } = await project(false);
  const model = scriptedModel([]); const out: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(2);
  expect(ConfigSchema.safeParse(await artifacts.readYaml('config.yaml', ConfigSchema)).success).toBe(true);
  expect(ConfigSchema.safeParse(CONFIG_TEMPLATE).success).toBe(true);
  expect(out.join('\n')).toContain('模板');
  expect(model.doGenerateCalls).toHaveLength(0);
});

it('生成 7 份画像草稿且不写确认记录；重跑时保留已确认文件的原字节和确认记录', async () => {
  const { root, artifacts } = await project(true);
  const model = scriptedModel(STEPS); const out: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(0);
  for (const name of Object.keys(FILES)) expect(await readProfileFile(artifacts, name as keyof typeof FILES)).toMatchObject({ present: true, ok: true });
  expect(await artifacts.readBytes('approvals.json')).toBeUndefined();

  const env = await readProfileFile(artifacts, 'environments.yaml');
  if (!env.present || !env.ok) throw new Error('环境画像应合法');
  const approvals = Approvals.empty();
  approvals.approve('profile', 'environments.yaml', env.value, '人工');
  await approvals.save(artifacts);
  const envBytes = await artifacts.readBytes('system/environments.yaml');
  const approvalBytes = await artifacts.readBytes('approvals.json');
  const second = scriptedModel(STEPS.slice(1));
  expect(await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: deps(second) })).toBe(0);
  expect(second.doGenerateCalls).toHaveLength(4);
  expect(await artifacts.readBytes('system/environments.yaml')).toEqual(envBytes);
  expect(await artifacts.readBytes('approvals.json')).toEqual(approvalBytes);
  expect(out.join('\n')).toContain('跳过（已确认）');
});

it.each([false, true])('七画像已确认时 auth 一次读取故障（并发取消=%s）退出3，零模型且字节全不变', async (cancel) => {
  const { root, artifacts } = await project(true);
  const approvals = Approvals.empty();
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
  const code = await cliMain(['init', '--project', root], { log: (s) => logs.push(s), dependencies: deps(model), signal: controller.signal });
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
  const approvals = Approvals.empty();
  approvals.approve('profile', 'environments.yaml', env.value, '人工');
  approvals.approve('profile', 'auth.yaml', { invalid: true }, '人工');
  await approvals.save(artifacts);
  await artifacts.writeYaml('system/environments.yaml', { version: 1, environments: { local: { baseURL: 'http://localhost:4000' } } });
  await artifacts.writeYaml('system/auth.yaml', { invalid: true });
  await artifacts.writeYaml('system/pages.yaml', FILES['pages.yaml']);
  const model = scriptedModel(STEPS);
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
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
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(2);
  expect(await readProfileFile(artifacts, 'auth.yaml')).toEqual({ name: 'auth.yaml', present: false });
  expect(await readProfileFile(artifacts, 'guardrails.yaml')).toMatchObject({ ok: true });
});

it.each([false, true])('预先取消时不写模板或草稿、不解析模型（已有配置：%s）', async (withConfig) => {
  const { root, artifacts } = await project(withConfig);
  const before = await artifacts.readBytes('config.yaml');
  const model = scriptedModel([]);
  const factories = { ollama: vi.fn(() => model) };
  expect(await cliMain(['init', '--project', root], {
    log: () => {}, signal: AbortSignal.abort(), dependencies: { modelOptions: { env: {}, factories } },
  })).toBe(2);
  expect(await artifacts.readBytes('config.yaml')).toEqual(before);
  expect(await artifacts.list('system')).toEqual([]);
  expect(factories.ollama).not.toHaveBeenCalled();
  expect(model.doGenerateCalls).toHaveLength(0);
});

it('扫描后取消不再解析模型或写入草稿', async () => {
  const { root, artifacts } = await project(true);
  const controller = new AbortController();
  const factory = vi.fn(() => scriptedModel([]));
  expect(await cliMain(['init', '--project', root], {
    log: () => controller.abort(), signal: controller.signal,
    dependencies: { modelOptions: { env: {}, factories: { ollama: factory } } },
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
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model), signal: controller.signal })).toBe(2);
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
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model), signal: controller.signal })).toBe(2);
  expect(model.doGenerate).toHaveBeenCalledTimes(2);
  expect(await artifacts.readBytes('system/environments.yaml')).toBeUndefined();
  expect(await artifacts.readBytes('system/pages.yaml')).toEqual(before);
  expect(await artifacts.list('system')).toEqual(['pages.yaml']);
  expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
});

it.each(['environments.yaml', 'guardrails.yaml'])('写入 %s 期间取消保留已完整写入文件，退出 2 并停止后续写入', async (cancelAt) => {
  const { root, artifacts } = await project(true);
  const controller = new AbortController();
  const original = ArtifactStore.prototype.writeYaml;
  vi.spyOn(ArtifactStore.prototype, 'writeYaml').mockImplementation(async function (this: ArtifactStore, rel, value) {
    await original.call(this, rel, value);
    if (rel === `system/${cancelAt}`) controller.abort();
  });
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(scriptedModel(STEPS)), signal: controller.signal })).toBe(2);
  expect(await readProfileFile(artifacts, 'environments.yaml')).toMatchObject({ ok: true });
  if (cancelAt === 'environments.yaml') expect(await artifacts.list('system')).toEqual(['environments.yaml']);
  else expect(await artifacts.list('system')).toHaveLength(7);
  expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
});

it('配置缺密钥是宿主错误，保留具体诊断', async () => {
  const { root, artifacts } = await project(true);
  await artifacts.writeYaml('config.yaml', CONFIG_TEMPLATE);
  const out: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: { env: {} } })).toBe(3);
  expect(out.join('\n')).toContain('ANTHROPIC_API_KEY');
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
  expect(await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: deps(scriptedModel(STEPS)), signal: controller.signal })).toBe(3);
  expect(out.join('\n')).toContain('宿主错误');
  expect(out.join('\n')).toContain('工件写入失败');
  expect(await readProfileFile(artifacts, 'environments.yaml')).toMatchObject({ ok: true });
  expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
});

it('withInterrupt 预先取消不执行回调，结束后移除监听器', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const fn = vi.fn(async () => 0);
  await expect(withInterrupt(AbortSignal.abort(), fn)).rejects.toBeInstanceOf(InterruptedError);
  expect(fn).not.toHaveBeenCalled();
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
});

it.each(['reason', 'AbortError', 'host'] as const)('withInterrupt 仅转换明确取消，保留宿主错误（%s）', async (kind) => {
  const controller = new AbortController();
  const host = new Error('真实磁盘故障');
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const result = withInterrupt(controller.signal, async (signal) => {
    controller.abort(host);
    if (kind === 'host') throw host;
    if (kind === 'AbortError') throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    signal.throwIfAborted();
    return 0;
  });
  if (kind === 'host') await expect(result).rejects.toBe(host);
  else await expect(result).rejects.toBeInstanceOf(InterruptedError);
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
});

it.each(['SIGINT', 'SIGTERM'] as const)('withInterrupt 接管 %s 并恢复监听器', async (event) => {
  const before = process.listenerCount(event);
  await expect(withInterrupt(undefined, async (signal) => {
    process.emit(event);
    signal.throwIfAborted();
    return 0;
  })).rejects.toBeInstanceOf(InterruptedError);
  expect(process.listenerCount(event)).toBe(before);
  await expect(withInterrupt(undefined, async () => 7)).resolves.toBe(7);
});

it('公共模型解析优先使用命令 env，并记录备用模型缺密钥警告', () => {
  const config = ConfigSchema.parse({
    models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r', fallback: { extractor: 'anthropic:backup' } },
    providers: { mock: { type: 'ollama', apiKeyEnv: 'MOCK_KEY' } },
  });
  let key: string | undefined;
  const out: string[] = [];
  const models = resolveModels(config, 'extractor', {
    env: { MOCK_KEY: '命令密钥' },
    modelOptions: { env: { MOCK_KEY: '模型密钥', ANTHROPIC_API_KEY: '备用密钥' }, factories: { ollama: (options) => { key = options.apiKey; return scriptedModel([]); } } },
  }, (s) => out.push(s));
  expect(key).toBe('命令密钥');
  expect(models.map((m) => m.ref)).toEqual(['mock:x']);
  expect(out.join('\n')).toContain('跳过备用模型');
});
