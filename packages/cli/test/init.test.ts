import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { projectUsageLocation, readUsage } from '@crosscheck/models';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Approvals, ArtifactError, ArtifactStore, ConfigSchema, ProjectConfigSchema, readProfileFile } from '@crosscheck/core';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import * as discovery from '@crosscheck/discovery';
import { cliMain as realCliMain, parseArgs } from '../src/main';
const cliMain: typeof realCliMain = (argv, options = {}) => {
  const index = argv.indexOf('--project');
  return realCliMain(argv, { ...options, dependencies: { ...options.dependencies, userConfigHome: index >= 0 ? path.join(argv[index + 1]!, 'user') : undefined } });
};
import { CONFIG_TEMPLATE, NOTES_FILE } from '../src/init';
import { InterruptedError, resolveModels, withInterrupt } from '../src/context';

it('init 接受可重复的 --openapi 并去重', () => {
  expect(parseArgs(['init', '--openapi', 'a.yaml', '--openapi', 'b.yaml', '--openapi', 'a.yaml']).openapi).toEqual(['a.yaml', 'b.yaml']);
  expect(() => parseArgs(['init', '--module', 'M'])).toThrow();
});

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
const deps = (model: ReturnType<typeof scriptedModel>) => ({ modelOptions: { env: {}, factories: { openai: () => model } }, resilience: { retries: 0, baseDelayMs: 0 }, review: { isTTY: false } });
const PROFILE_STEPS: ScriptStep[] = [
  { toolCalls: [{ name: 'finish', input: { findings: [] } }] },
  { toolCalls: [{ name: 'finish', input: { 'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:3000', healthcheck: 'http://localhost:3000/health', reset: null } } } } }] },
  { toolCalls: [{ name: 'finish', input: { 'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } } } }] },
  { toolCalls: [{ name: 'finish', input: { 'api-catalog.yaml': { version: 1, operations: {} }, 'pages.yaml': { version: 1, pages: {} } } }] },
  { toolCalls: [{ name: 'finish', input: { 'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: {} } } }] },
  { toolCalls: [{ name: 'finish', input: { 'guardrails.yaml': { allowedHosts: ['localhost:3000'] } } }] },
];

it('没有 config.yaml 时写入默认配置并一次完成笔记生成', async () => {
  const { root, artifacts } = await project(false);
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown: '# 项目笔记\n\n扫描结果' } }] }, ...PROFILE_STEPS]); const out: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(2);
  expect(ProjectConfigSchema.safeParse(await artifacts.readYaml('config.yaml', ProjectConfigSchema)).success).toBe(true);
  expect(ProjectConfigSchema.safeParse(CONFIG_TEMPLATE).success).toBe(true);
  expect(out.join('\n')).toContain('默认配置');
  expect((await artifacts.readBytes(NOTES_FILE))?.toString()).toBe('# 项目笔记\n\n扫描结果');
});

it('直接运行 init 为笔记和嵌套画像的每次实际请求各记一次且不归会话', async () => {
  const { root } = await project(true);
  const home = path.join(root, 'user');
  const model = scriptedModel([
    { toolCalls: [{ name: 'list_dir', input: {} }] },
    { toolCalls: [{ name: 'finish', input: { markdown: '# 项目笔记' } }] },
    ...PROFILE_STEPS,
  ]);
  const logs: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: line => logs.push(line), dependencies: deps(model) })).toBe(2);
  expect(logs.join('\n')).toContain('当前不是交互式终端');
  expect(model.doGenerateCalls).toHaveLength(8);
  const report = await readUsage({ project: root, home });
  expect(report.total.calls).toBe(8);
  expect(report.byCommand.init?.calls).toBe(2);
  expect(report.byCommand.profile?.calls).toBe(6);
  expect(report.byRole.extractor?.calls).toBe(8);
  const { directory } = await projectUsageLocation(root, home);
  for (const file of await readdir(directory)) expect(JSON.parse(await readFile(path.join(directory, file), 'utf8')).sessionId).toBeNull();
});

it('init 账本路径冲突不影响笔记生成，优先通过会话警告且不泄露路径', async () => {
  const { root, artifacts } = await project(true);
  await writeFile(path.join(root, 'user', '.crosscheck', 'projects'), '占用目录');
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown: '# 项目笔记' } }] }, ...PROFILE_STEPS]);
  const warnings: string[] = [], logs: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: line => logs.push(line), dependencies: { ...deps(model), init: { deferReview: () => {} }, usageContext: { sessionId: 's1', warn: line => warnings.push(line) } } })).toBe(0);
  expect((await artifacts.readBytes(NOTES_FILE))?.toString()).toBe('# 项目笔记');
  expect(model.doGenerateCalls).toHaveLength(7);
  expect(warnings).toEqual(Array(7).fill('用量记录写入失败，本次统计不完整'));
  expect(logs.join('\n')).not.toContain('用量记录写入失败');
});

it('预先取消时不写默认配置', async () => {
  const { root, artifacts } = await project(false);
  expect(await cliMain(['init', '--project', root], { log: () => {}, signal: AbortSignal.abort(), dependencies: deps(scriptedModel([])) })).not.toBe(0);
  expect(await artifacts.readBytes('config.yaml')).toBeUndefined();
});

it('生成笔记并自动确认', async () => {
  const { root, artifacts } = await project(true);
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown: `# 项目笔记

扫描结果` } }] }, ...PROFILE_STEPS]);
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(2);
  expect((await artifacts.readBytes(NOTES_FILE))?.toString()).toBe(`# 项目笔记

扫描结果`);
  expect((await Approvals.load(artifacts)).record('notes', 'project')?.by).toBe('auto');
});

it('已确认笔记跳过生成并保留人工身份，缺少画像时继续调用模型', async () => {
  const { root, artifacts } = await project(true); const text = '# 已确认';
  await artifacts.writeBytes('notes.md', Buffer.from(text));
  const approvals = Approvals.empty(); approvals.approve('notes', 'project', text, '人工'); await approvals.save(artifacts);
  const model = scriptedModel(PROFILE_STEPS);
  const lines: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: (line) => lines.push(line), dependencies: deps(model) })).toBe(2);
  expect(lines.join('\n')).toContain('跳过生成');
  expect(model.doGenerateCalls).toHaveLength(PROFILE_STEPS.length);
  expect(await artifacts.list('system')).toHaveLength(7);
  expect((await Approvals.load(artifacts)).record('notes', 'project')).toEqual(approvals.record('notes', 'project'));
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

it('刷新已确认笔记时脱敏旧内容并以 auto 重新确认', async () => {
  const { root, artifacts } = await project(true); const text = '# 笔记\n\nfixture-key';
  await artifacts.writeBytes('notes.md', Buffer.from(text));
  const approvals = Approvals.empty(); approvals.approve('notes', 'project', text, '人工'); await approvals.save(artifacts);
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown: '# 新笔记\n\nfixture-key' } }] }, ...PROFILE_STEPS]);
  expect(await cliMain(['init', '--refresh', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(2);
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toContain('fixture-key');
  const updated = (await artifacts.readBytes('notes.md'))!.toString();
  expect(updated).not.toContain('fixture-key');
  const latest = await Approvals.load(artifacts);
  expect(latest.state('notes', 'project', updated)).toBe('approved');
  expect(latest.record('notes', 'project')?.by).toBe('auto');
});

it('模型笔记里的未知密码、认证头、URL 和多行秘密不落盘', async () => {
  const { root, artifacts } = await project(true);
  const markdown = '# 项目笔记\n\nPASSWORD=unknownpassword\nAuthorization: Bearer unknownbearer\nhttp://unknownuser:unknownpass@localhost:3000/?x=unknownquery\nsecret: |\n  unknownmultiline\n  unknownsecondline\n\n正常说明';
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown } }] }, ...PROFILE_STEPS]);
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(2);
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

it('模型按需读取项目文件，CLI 输出读取进度且不再报告摘录省略', async () => {
  const { root, artifacts } = await project(true);
  await writeFile(path.join(root, 'package.json'), '{ "scripts": { "dev": "vite" } }');
  const model = scriptedModel([{ toolCalls: [{ name: 'read_file', input: { path: 'package.json' } }] }, { toolCalls: [{ name: 'finish', input: { markdown: '# 项目笔记' } }] }, ...PROFILE_STEPS]);
  const out: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(2);
  expect(out).toContain('读取 package.json');
  expect(out.join('\n')).not.toContain('摘录');
  expect((await artifacts.readBytes(NOTES_FILE))?.toString()).toBe('# 项目笔记');
});

it('扫描预算耗尽时提示调大 budget.discovery', async () => {
  const { root, artifacts } = await project(true);
  await artifacts.writeYaml('config.yaml', { budget: { discovery: { steps: 1 } } });
  const model = scriptedModel([{ toolCalls: [{ name: 'list_dir', input: {} }] }, { toolCalls: [{ name: 'finish', input: { markdown: '# 项目笔记' } }] }]);
  const out: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(2);
  expect(out.join('\n')).toContain('budget.discovery');
  expect(await artifacts.readBytes(NOTES_FILE)).toBeUndefined();
});
