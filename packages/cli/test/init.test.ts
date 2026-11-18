import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Approvals, ArtifactError, ArtifactStore, ConfigSchema, ProjectConfigSchema, readProfileFile } from '@crosscheck/core';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import * as discovery from '@crosscheck/discovery';
import { cliMain as realCliMain } from '../src/main';
const cliMain: typeof realCliMain = (argv, options = {}) => {
  const index = argv.indexOf('--project');
  return realCliMain(argv, { ...options, dependencies: { ...options.dependencies, userConfigHome: index >= 0 ? path.join(argv[index + 1]!, 'user') : undefined } });
};
import { CONFIG_TEMPLATE, NOTES_FILE } from '../src/init';
import { InterruptedError, resolveModels, withInterrupt } from '../src/context';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function project(withConfig: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cli-init-')); roots.push(root);
  const artifacts = new ArtifactStore(root);
  await mkdir(path.join(root, 'user', '.crosscheck'), { recursive: true });
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' }, providers: { mock: { type: 'openai', baseURL: 'https://example.invalid/v1', apiKey: 'fixture-key' } } }));
  if (withConfig) await artifacts.writeYaml('config.yaml', {});
  return { root, artifacts };
}
const deps = (model: ReturnType<typeof scriptedModel>) => ({ modelOptions: { env: {}, factories: { openai: () => model } }, resilience: { retries: 0, baseDelayMs: 0 } });

it('没有 config.yaml 时写入合法模板并退出 2，不调用模型', async () => {
  const { root, artifacts } = await project(false);
  const model = scriptedModel([]); const out: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(2);
  expect(ProjectConfigSchema.safeParse(await artifacts.readYaml('config.yaml', ProjectConfigSchema)).success).toBe(true);
  expect(ProjectConfigSchema.safeParse(CONFIG_TEMPLATE).success).toBe(true);
  expect(out.join('\n')).toContain('模板');
  expect(model.doGenerateCalls).toHaveLength(0);
});

it('生成笔记草稿且不创建确认记录', async () => {
  const { root, artifacts } = await project(true);
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown: `# 项目笔记

扫描结果` } }] }]);
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  expect((await artifacts.readBytes(NOTES_FILE))?.toString()).toBe(`# 项目笔记

扫描结果`);
  expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
});

it('已确认笔记跳过时无需全局模型配置', async () => {
  const { root, artifacts } = await project(true); const text = '# 已确认';
  await artifacts.writeBytes('notes.md', Buffer.from(text));
  const approvals = Approvals.empty(); approvals.approve('notes', 'project', text, '人工'); await approvals.save(artifacts);
  await rm(path.join(root, 'user', '.crosscheck', 'config.yaml'));
  expect(await cliMain(['init', '--project', root], { log: () => {} })).toBe(0);
});

it.each(['无标题内容', '# 标题\n' + 'a'.repeat(65536)])('刷新时拒绝非法旧笔记且不调用模型', async (text) => {
  const { root, artifacts } = await project(true);
  await artifacts.writeBytes('notes.md', Buffer.from(text));
  const model = scriptedModel([]); const logs: string[] = [];
  expect(await cliMain(['init', '--refresh', '--project', root], { log: (line) => logs.push(line), dependencies: deps(model) })).toBe(2);
  expect(logs.join(' ')).toContain('笔记');
  expect(model.doGenerateCalls).toHaveLength(0);
  expect((await artifacts.readBytes('notes.md'))!.toString()).toBe(text);
});

it('刷新时检测模型执行期间笔记发生修改', async () => {
  const { root, artifacts } = await project(true); await artifacts.writeBytes('notes.md', Buffer.from('# 原内容'));
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown: '# 新草稿' } }] }]);
  const generate = model.doGenerate.bind(model);
  vi.spyOn(model, 'doGenerate').mockImplementation(async (options) => { await artifacts.writeBytes('notes.md', Buffer.from('# 并发修改')); return generate(options); });
  expect(await cliMain(['init', '--refresh', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(2);
  expect((await artifacts.readBytes('notes.md'))?.toString()).toBe('# 并发修改');
});

it('画像缺少确认笔记时即使模型配置缺失也返回门禁', async () => {
  const { root, artifacts } = await project(true); await rm(path.join(root, 'user', '.crosscheck', 'config.yaml'));
  const logs: string[] = [];
  expect(await cliMain(['profile', '--project', root], { log: (line) => logs.push(line) })).toBe(2);
  expect(logs.join(' ')).toContain('review notes');
  expect(await artifacts.list('system')).toEqual([]);
});

it('刷新已确认笔记时脱敏旧内容并保留原确认记录', async () => {
  const { root, artifacts } = await project(true); const text = '# 笔记\n\nfixture-key';
  await artifacts.writeBytes('notes.md', Buffer.from(text));
  const approvals = Approvals.empty(); approvals.approve('notes', 'project', text, '人工'); await approvals.save(artifacts);
  const before = await artifacts.readBytes('approvals.json');
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown: '# 新笔记\n\nfixture-key' } }] }]);
  expect(await cliMain(['init', '--refresh', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toContain('fixture-key');
  const updated = (await artifacts.readBytes('notes.md'))!.toString();
  expect(updated).not.toContain('fixture-key');
  expect((await Approvals.load(artifacts)).state('notes', 'project', updated)).toBe('stale');
  expect(await artifacts.readBytes('approvals.json')).toEqual(before);
});

it('模型笔记里的未知密码、认证头、URL 和多行秘密不落盘', async () => {
  const { root, artifacts } = await project(true);
  const markdown = '# 项目笔记\n\nPASSWORD=unknownpassword\nAuthorization: Bearer unknownbearer\nhttp://unknownuser:unknownpass@localhost:3000/?x=unknownquery\nsecret: |\n  unknownmultiline\n  unknownsecondline\n\n正常说明';
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown } }] }]);
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  const text = (await artifacts.readBytes('notes.md'))!.toString();
  for (const secret of ['unknownpassword', 'unknownbearer', 'unknownuser', 'unknownpass', 'unknownquery', 'unknownmultiline', 'unknownsecondline']) expect(text).not.toContain(secret);
  expect(text).toContain('正常说明');
});

it('脱敏后格式不合规则不覆盖原笔记', async () => {
  const { root, artifacts } = await project(true);
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' }, providers: { mock: { type: 'openai', baseURL: 'https://example.invalid/v1', apiKey: '# secret' } } }));
  await artifacts.writeBytes('notes.md', Buffer.from('# 原笔记'));
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown: '# secret' } }] }]);
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(2);
  expect((await artifacts.readBytes('notes.md'))!.toString()).toBe('# 原笔记');
});

it('生成笔记同时发生取消与宿主异常时保留宿主错误', async () => {
  const { root } = await project(true); const controller = new AbortController();
  vi.spyOn(discovery, 'synthesizeNotes').mockImplementation(async () => { controller.abort(); throw new Error('真实宿主异常'); });
  const logs: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: (line) => logs.push(line), signal: controller.signal, dependencies: deps(scriptedModel([])) })).toBe(3);
  expect(logs.join(' ')).toContain('真实宿主异常');
});

it('笔记生成期间草稿被确认时不覆盖', async () => {
  const { root, artifacts } = await project(true); const text = '# 人工确认';
  await artifacts.writeBytes('notes.md', Buffer.from(text));
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown: '# 新笔记' } }] }]);
  const generate = model.doGenerate.bind(model);
  vi.spyOn(model, 'doGenerate').mockImplementation(async (options) => {
    const approvals = await Approvals.load(artifacts); approvals.approve('notes', 'project', text, '人工'); await approvals.save(artifacts);
    return generate(options);
  });
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(2);
  expect((await artifacts.readBytes('notes.md'))!.toString()).toBe(text);
});

it.each(['init', 'profile'] as const)('%s 拒绝非法 UTF-8 笔记，不调用模型或覆盖笔记', async (command) => {
  const { root, artifacts } = await project(true);
  const bytes = Buffer.from([0x23, 0x20, 0xff]);
  await artifacts.writeBytes('notes.md', bytes);
  const approvals = Approvals.empty();
  approvals.approve('notes', 'project', bytes.toString('utf8'), '人工');
  await approvals.save(artifacts);
  const before = await artifacts.readBytes('approvals.json');
  const model = scriptedModel([]); const logs: string[] = [];
  expect(await cliMain([command, '--project', root], { log: (line) => logs.push(line), dependencies: deps(model) })).toBe(2);
  expect(logs.join(' ')).toContain('UTF-8');
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(await artifacts.readBytes('notes.md')).toEqual(bytes);
  expect(await artifacts.readBytes('approvals.json')).toEqual(before);
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

it('公共模型解析使用独立密钥集合，并记录备用模型缺密钥警告', () => {
  const config = ConfigSchema.parse({
    models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r', fallback: { extractor: 'anthropic:backup' } },
    providers: { mock: { type: 'openai', baseURL: 'https://example.invalid/v1', apiKeyEnv: 'MOCK_KEY' }, anthropic: { type: 'anthropic', baseURL: 'https://api.anthropic.com/v1' } },
  });
  let key: string | undefined;
  const out: string[] = [];
  const models = resolveModels(config, 'extractor', {
    env: { MOCK_KEY: '命令密钥' },
    modelOptions: { env: { MOCK_KEY: '模型密钥', ANTHROPIC_API_KEY: '备用密钥' }, apiKeys: { mock: '全局密钥' }, factories: { openai: (options) => { key = options.apiKey; return scriptedModel([]); } } },
  }, (s) => out.push(s));
  expect(key).toBe('全局密钥');
  expect(models.map((m) => m.ref)).toEqual(['mock:x']);
  expect(out.join('\n')).toContain('跳过备用模型');
});
