import { expect, it, vi } from 'vitest';
import { readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createUsageObserver, projectUsageLocation, readUsage, withProgress, type UsageEvent } from '@crosscheck/models';
import path from 'node:path';
import { afterEach } from 'vitest';
import { APICallError, type LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

type ModelV2 = Extract<LanguageModel, { specificationVersion: 'v2' }>;
class TestModelV2 implements ModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider = 'mock-provider';
  readonly modelId = 'mock-model';
  readonly supportedUrls = {};
  doGenerate: ModelV2['doGenerate'] = async () => { throw new Error('未设置模型回执'); };
  doStream: ModelV2['doStream'] = async () => { throw new Error('不应启动流'); };
}
import { ReviewSession, approveClause } from '@crosscheck/tui';
import { clause } from '../../tui/test/fixture';
import { scriptedModel } from '../../agent/src/testing/scripted-model';
import { cleanupProjects, createProject } from '../../tui/test/fixture';
import { chatReply as realChatReply, createSlashDispatcher, loadSessionInfo, sessionSlashCommands, tokenizeCommand } from '../src/session';
import cliPackage from '../package.json';
const chatReply: typeof realChatReply = (root, history, text, deps, signal) => realChatReply(root, history, text, { ...deps, userConfigHome: path.join(root, 'user') }, signal);

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await cleanupProjects(); });

it('聊天无需确认人或审核会话，读取已有确认且不写入确认记录', async () => {
  const { root, artifacts, session } = await createProject();
  await artifacts.saveClauses('M', [clause(1), clause(2)]);
  await approveClause(session, 'M', 'M-AC-1');
  const before = await artifacts.readBytes('approvals.json');
  const open = vi.spyOn(ReviewSession, 'open').mockRejectedValue(new Error('聊天不能打开审核会话'));
  const model = scriptedModel([{ text: '只读回答' }]);
  const reply = await chatReply(root, [], '还有多少', { env: {}, modelOptions: { env: {}, factories: { openai: () => model } } }, new AbortController().signal);
  expect(reply).toBe('只读回答');
  expect(open).not.toHaveBeenCalled();
  expect(model.doGenerateCalls[0]!.prompt[0]).toMatchObject({ role: 'system', content: expect.stringContaining('"clausesPending":1') });
  expect(await artifacts.readBytes('approvals.json')).toEqual(before);
});

it('可重试模型错误只由 fallback 控制重试次数', async () => {
  const { root } = await createProject();
  const error = new APICallError({ message: '服务不可用', url: 'https://example.test', requestBodyValues: {}, statusCode: 503, isRetryable: true });
  const model = scriptedModel([{ error }, { text: '不应重试' }]);
  await expect(chatReply(root, [], '你好', { resilience: { retries: 0 }, modelOptions: { env: {}, factories: { openai: () => model } } }, new AbortController().signal)).rejects.toThrow();
  expect(model.doGenerateCalls).toHaveLength(1);
});

async function usageEvents(project: string, home = path.join(project, 'user')): Promise<UsageEvent[]> {
  const { directory } = await projectUsageLocation(project, home);
  const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return Promise.all(files.map(async file => JSON.parse(await readFile(path.join(directory, file), 'utf8'))));
}

it('聊天仅为实际主备请求逐次入账，成功回执保留四项用量', async () => {
  const { root } = await createProject();
  const sessionId = randomUUID();
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:primary', executor: 'mock:e', reviewer: 'mock:r', fallback: { planner: 'mock:backup' } }, providers: { mock: { type: 'openai', baseURL: 'https://example.invalid/v1', apiKey: 'fixture-key' } } }));
  const primary = scriptedModel([{ error: new Error('首次失败') }, { error: new Error('重试失败') }]);
  const backup = scriptedModel([{ text: '备用回复', usage: { input: 19, output: 7, cacheRead: 4, cacheWrite: 2 } }]);
  expect(await chatReply(root, [], '提问', { usageContext: { sessionId, warn: () => {} }, resilience: { retries: 1, sleep: async () => {} }, modelOptions: { env: {}, factories: { openai: ({ modelId }) => modelId === 'primary' ? primary : backup } } }, new AbortController().signal)).toBe('备用回复');
  const events = await usageEvents(root);
  expect(events).toHaveLength(3);
  for (const event of events) expect(event).toMatchObject({ sessionId, command: 'chat', role: 'planner', purpose: 'request' });
  expect(events.filter(event => event.status === 'error')).toEqual(Array(2).fill(expect.objectContaining({ configuredRef: 'mock:primary', usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } })));
  expect(events.find(event => event.status === 'success')).toMatchObject({ configuredRef: 'mock:backup', usage: { inputTokens: 19, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: 2 } });
});

it('聊天仅将进入模型后取消的请求记为 cancelled，预取消不记账', async () => {
  const { root } = await createProject();
  const controller = new AbortController();
  const model = scriptedModel([{ hangWithGenericError: true }]);
  const generate = model.doGenerate.bind(model);
  vi.spyOn(model, 'doGenerate').mockImplementation(options => {
    const result = generate(options);
    controller.abort();
    return result;
  });
  const deps = { modelOptions: { env: {}, factories: { openai: () => model } } };
  await expect(chatReply(root, [], '预取消', deps, AbortSignal.abort())).rejects.toThrow();
  const beforeGenerate = new AbortController();
  await expect(withProgress(line => {
    if (line.startsWith('请求模型')) beforeGenerate.abort();
  }, () => chatReply(root, [], '生成前取消', deps, beforeGenerate.signal))).rejects.toThrow();
  expect(await usageEvents(root)).toEqual([]);
  expect(model.doGenerateCalls).toHaveLength(0);
  await expect(chatReply(root, [], '取消请求', deps, controller.signal)).rejects.toThrow('连接中断');
  expect(await usageEvents(root)).toEqual([expect.objectContaining({ status: 'cancelled', sessionId: null, usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } })]);
});

it.each([
  { raw: { input_tokens: 19, output_tokens: 7, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 2 } }, expected: { inputTokens: 19, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 2 } },
  { raw: { input_tokens: '19', output_tokens: 7, input_tokens_details: { cached_tokens: -1, cache_write_tokens: 1.5 } }, expected: { inputTokens: null, outputTokens: 7, cacheReadTokens: null, cacheWriteTokens: null } },
  { raw: undefined, expected: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } },
])('内置 OpenAI 拒绝无 output 的回执时，聊天失败且仅记录有效白名单用量（$raw）', async ({ raw, expected }) => {
  const { root } = await createProject();
  const fetch = vi.fn(async () => Response.json({
    id: 'response', created_at: 1, model: 'p', secret: '不可落入账本的响应正文', usage: raw,
  }));
  vi.stubGlobal('fetch', fetch);
  await expect(chatReply(root, [], '提问', { modelOptions: { env: {} }, resilience: { retries: 0 } }, new AbortController().signal)).rejects.toThrow(/output|Invalid JSON response/i);
  expect(fetch).toHaveBeenCalledTimes(1);
  const events = await usageEvents(root);
  expect(events).toEqual([expect.objectContaining({ status: 'error', usage: expected })]);
  expect(JSON.stringify(events)).not.toContain('不可落入账本的响应正文');
});

it.each([undefined, 0])('内置 OpenAI 成功原始回执的缓存读 %s 与费用对应', async cachedTokens => {
  const { root } = await createProject();
  const config = path.join(root, 'user', '.crosscheck', 'config.yaml');
  const settings = JSON.parse(await readFile(config, 'utf8'));
  await writeFile(config, JSON.stringify({ ...settings, pricing: { 'mock:p': { inputPerMTok: 10, outputPerMTok: 20 } } }));
  const fetch = vi.fn(async () => Response.json({
    id: 'response', created_at: 1, model: 'p',
    output: [{ type: 'message', role: 'assistant', id: 'msg', content: [{ type: 'output_text', text: '真实回复', annotations: [] }] }],
    usage: { input_tokens: 19, output_tokens: 7, input_tokens_details: { cached_tokens: cachedTokens, cache_write_tokens: 2 } },
  }));
  vi.stubGlobal('fetch', fetch);
  await expect(chatReply(root, [], '提问', { modelOptions: { env: {} }, resilience: { retries: 0 } }, new AbortController().signal)).resolves.toBe('真实回复');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await usageEvents(root)).toEqual([expect.objectContaining({
    status: 'success', usage: { inputTokens: 19, outputTokens: 7, cacheReadTokens: cachedTokens ?? null, cacheWriteTokens: 2 },
    cost: cachedTokens === undefined ? null : expect.closeTo(0.00033, 10),
  })]);
});

it('模型已返回回执但 SDK 后处理失败时保留用量和原错误', async () => {
  const { root } = await createProject();
  const model = scriptedModel([{ text: '不会显示', usage: { input: 19, output: 7, cacheRead: 0, cacheWrite: 2 } }]);
  const generate = model.doGenerate.bind(model);
  vi.spyOn(model, 'doGenerate').mockImplementation(async options => ({
    ...await generate(options),
    get content(): never { throw new Error('SDK 后处理读取内容失败'); },
  }));
  await expect(chatReply(root, [], '提问', { resilience: { retries: 0 }, modelOptions: { env: {}, factories: { openai: () => model } } }, new AbortController().signal)).rejects.toThrow('SDK 后处理读取内容失败');
  expect(await usageEvents(root)).toEqual([expect.objectContaining({ status: 'error', usage: { inputTokens: 19, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 2 } })]);
});

it.each(['v2', 'v3'] as const)('%s 转换内容失败前保留原始用量及接收者', async version => {
  const { root } = await createProject();
  const brokenContent = { get content(): never { throw new Error('版本适配读取内容失败'); } };
  const model = version === 'v2'
    ? new TestModelV2()
    : new MockLanguageModelV3();
  if (version === 'v2') {
    const original = model as TestModelV2;
    vi.spyOn(original, 'doGenerate').mockImplementation(async function (this: TestModelV2, options) {
      expect(this).toBe(original);
      expect(options.prompt.at(-1)?.role).toBe('user');
      return { get content(): never { return brokenContent.content; }, finishReason: 'stop', usage: { inputTokens: 19, outputTokens: 7, totalTokens: 26, cachedInputTokens: 0 }, warnings: [] };
    });
  } else {
    const original = model as MockLanguageModelV3;
    vi.spyOn(original, 'doGenerate').mockImplementation(async function (this: MockLanguageModelV3, options) {
      expect(this).toBe(original);
      expect(options.prompt.at(-1)?.role).toBe('user');
      return { get content(): never { return brokenContent.content; }, finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 19, noCache: 17, cacheRead: 0, cacheWrite: 2 }, outputTokens: { total: 7, text: 7, reasoning: undefined } }, warnings: [] };
    });
  }
  await expect(chatReply(root, [], '提问', { resilience: { retries: 0 }, modelOptions: { env: {}, factories: { openai: () => model } } }, new AbortController().signal)).rejects.toThrow('版本适配读取内容失败');
  expect(await usageEvents(root)).toEqual([expect.objectContaining({ status: 'error', usage: { inputTokens: 19, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: version === 'v2' ? null : 2 } })]);
});

it('聊天账本写入失败不丢回复且只发脱敏告警', async () => {
  const { root } = await createProject();
  await writeFile(path.join(root, 'user', '.crosscheck', 'projects'), '占用目录');
  const warn = vi.fn();
  const model = scriptedModel([{ text: '保留回复' }]);
  expect(await chatReply(root, [], '提问', { usageContext: { sessionId: randomUUID(), warn }, modelOptions: { env: {}, factories: { openai: () => model } } }, new AbortController().signal)).toBe('保留回复');
  expect(warn.mock.calls).toEqual([['用量记录写入失败，本次统计不完整']]);
});

it('聊天结果和模型错误均清除全局密钥', async () => {
  const { root } = await createProject();
  const secret = 'CHAT_SECRET_829761';
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' }, providers: { mock: { type: 'openai', baseURL: 'https://example.invalid/v1', apiKey: secret } } }));
  const model = scriptedModel([{ text: `回复 ${secret}` }]);
  const reply = await chatReply(root, [], '你好', { modelOptions: { factories: { openai: () => model } } }, new AbortController().signal);
  expect(reply).not.toContain(secret);
  const failed = scriptedModel([{ error: new Error(`错误 ${secret}`) }]);
  await expect(chatReply(root, [], '你好', { resilience: { retries: 0 }, modelOptions: { factories: { openai: () => failed } } }, new AbortController().signal)).rejects.not.toThrow(secret);
});

it('聊天首次读取摘要并回退模型，不授予工具且保留历史', async () => {
  const { root, artifacts } = await createProject();
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:primary', executor: 'mock:e', reviewer: 'mock:r', fallback: { planner: 'mock:backup' } }, providers: { mock: { type: 'openai', baseURL: 'https://example.invalid/v1', apiKey: 'fixture-key' } } }));
  const primary = scriptedModel([{ error: new Error('模型故障') }]);
  const backup = scriptedModel([{ text: '只读回答' }]);
  const reply = await chatReply(root, [{ role: 'user', content: '上个问题' }, { role: 'assistant', content: '上个回答' }], '还有多少', { resilience: { retries: 0 }, modelOptions: { env: {}, factories: { openai: ({ modelId }) => modelId === 'primary' ? primary : backup } } }, new AbortController().signal);
  expect(reply).toBe('只读回答');
  const call = backup.doGenerateCalls[0]!;
  expect(call.tools ?? []).toHaveLength(0);
  expect(JSON.stringify(call.prompt)).toContain('profilePending');
  expect(JSON.stringify(call.prompt)).toContain('上个问题');
  expect(JSON.stringify(call.prompt)).toContain('不可执行写入或确认');
});

it('记录主备模型的认证失败且不泄露敏感信息', async () => {
  const { root } = await createProject();
  const secret = 'secret-key-123';
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:primary', executor: 'mock:e', reviewer: 'mock:r', fallback: { planner: 'mock:backup' } }, providers: { mock: { type: 'openai', baseURL: 'https://example.invalid/private-path?token=hidden', apiKey: secret } } }));
  const makeError = () => new APICallError({ message: `Unauthorized ${secret}`, url: 'https://example.invalid/private-path?token=hidden', requestBodyValues: { text: 'private-chat' }, statusCode: 401, isRetryable: false, responseHeaders: { 'x-request-id': 'request-123', authorization: secret }, responseBody: secret });
  await expect(chatReply(root, [], 'private-chat', { resilience: { retries: 0 }, modelOptions: { factories: { openai: () => scriptedModel([{ error: makeError() }]) } } }, new AbortController().signal)).rejects.toThrow();
  const content = await readFile(path.join(root, 'user', '.crosscheck', 'chat-errors.jsonl'), 'utf8');
  const records = content.trim().split('\n').map((line) => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ ref: 'mock:primary', endpoint: 'https://example.invalid', statusCode: 401, requestId: 'request-123', stage: 'model-request' });
  expect(records[1]).toMatchObject({ ref: 'mock:backup', statusCode: 401 });
  expect(content).not.toContain(secret);
  expect(content).not.toContain('private-chat');
  expect(content).not.toContain('private-path');
  expect(content).not.toContain('hidden');
});

it('默认记录实际模型请求并隐藏凭据', async () => {
  const { root } = await createProject();
  const secret = 'TEST_SECRET_abc123';
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' }, providers: { mock: { type: 'anthropic', baseURL: 'https://example.invalid/v1', apiKey: secret } } }));
  let sent: Request | undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    sent = new Request(input, init);
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Method Not Allowed' } }), { status: 405, headers: { 'content-type': 'application/json' } });
  });
  const log = path.join(root, 'user', '.crosscheck', 'chat-requests.jsonl');
  const signal = new AbortController().signal;
  await expect(chatReply(root, [], '这是测试问题', { env: {}, resilience: { retries: 0 } }, signal)).rejects.toThrow();
  const content = await readFile(log, 'utf8');
  const record = JSON.parse(content.trim());
  expect(record.method).toBe('POST');
  expect(record.url).toContain('/messages');
  expect(JSON.stringify(record.body)).toContain('这是测试问题');
  expect(content).not.toContain(secret);
  expect(record.headers['x-api-key']).toBe('[REDACTED]');
  expect(sent?.headers.get('x-api-key')).toBe(secret);
  expect(await sent?.clone().text()).toContain('这是测试问题');
  expect(await usageEvents(root)).toEqual([expect.objectContaining({ status: 'error', usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } })]);
});

it('日志不可写时仍保留原始模型错误', async () => {
  const { root } = await createProject();
  await mkdir(path.join(root, 'user', '.crosscheck', 'chat-errors.jsonl'));
  const model = scriptedModel([{ error: new Error('原始模型错误') }]);
  await expect(chatReply(root, [], '你好', { resilience: { retries: 0 }, modelOptions: { factories: { openai: () => model } } }, new AbortController().signal)).rejects.toThrow('原始模型错误');
});

it('缺少模型配置时聊天显示错误且不影响命令分发', async () => {
  const { root, artifacts } = await createProject();
  await rm(path.join(root, 'user', '.crosscheck', 'config.yaml'));
  const signal = new AbortController().signal;
  await expect(chatReply(root, [], '你好', {}, signal)).rejects.toThrow();
  expect(await createSlashDispatcher({})(['help'], signal)).toMatchObject({ kind: 'log', code: 0 });
});

it('启动信息读取全局模型配置和 CLI 版本', async () => {
  const { root } = await createProject();
  expect(await loadSessionInfo(path.join(root, 'user'))).toEqual({ version: cliPackage.version, configFile: '~/.crosscheck/config.yaml', models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' } });
});

it('全局配置文件不存在时启动信息不阻止会话', async () => {
  const { root } = await createProject();
  await rm(path.join(root, 'user', '.crosscheck', 'config.yaml'));
  expect(await loadSessionInfo(path.join(root, 'user'))).toEqual({ version: cliPackage.version, models: undefined });
});

it('全局配置无效时启动信息不阻止会话', async () => {
  const { root } = await createProject();
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), '{}');
  expect(await loadSessionInfo(path.join(root, 'user'))).toEqual({ version: cliPackage.version, models: undefined });
});

it('识别引号包围的含空格项目路径', () => {
  expect(tokenizeCommand('review cases --project "my project"')).toEqual(['review', 'cases', '--project', 'my project']);
  expect(() => tokenizeCommand('review "unterminated')).toThrow();
});

it('空斜杠不会递归启动会话', async () => {
  const dispatch = createSlashDispatcher({});
  expect(await dispatch([], new AbortController().signal)).toMatchObject({ kind: 'log', code: 2 });
});

it('clear 指令分发给会话清空且不接受参数', async () => {
  const dispatch = createSlashDispatcher({});
  const signal = new AbortController().signal;
  expect(await dispatch(['clear'], signal)).toEqual({ kind: 'clear' });
  expect(await dispatch(['clear', 'extra'], signal)).toMatchObject({ kind: 'log', code: 2 });
});

it('status 指令读取指定项目状态且拒绝无效参数', async () => {
  const { root } = await createProject();
  const dispatch = createSlashDispatcher({});
  const signal = new AbortController().signal;
  const result = await dispatch(['status', '--project', root], signal);
  expect(result).toMatchObject({ kind: 'log', code: 0 });
  if (result.kind !== 'log') throw new Error('状态命令应返回日志');
  expect(result.lines.join('\n')).toContain('当前阶段');
  expect(result.lines.join('\n')).toContain('待审核');
  expect(result.lines.join('\n')).toContain('上一次测试');
  expect(await dispatch(['status', '--unknown'], signal)).toMatchObject({ kind: 'log', code: 2 });
});

it('/usage 固定查询启动项目，区分项目和指定会话，并显示已知部分及损坏诊断', async () => {
  const { root } = await createProject();
  const home = path.join(root, 'user');
  const currentId = randomUUID(), otherId = randomUUID();
  const options = { project: root, home, command: 'chat' as const, role: 'planner' as const, pricing: { 'mock:p': { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 3, cacheWritePerMTok: 4 } }, warn: () => {} };
  await createUsageObserver({ ...options, sessionId: currentId })({ ref: 'mock:p', status: 'success', purpose: 'request', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3 } });
  await createUsageObserver({ ...options, sessionId: otherId, command: 'init', role: 'extractor' })({ ref: 'mock:x', status: 'error', purpose: 'request', usage: null });
  const { directory } = await projectUsageLocation(root, home);
  await writeFile(path.join(directory, 'broken.json'), '{');
  const dispatch = createSlashDispatcher({ userConfigHome: home }, { currentId, project: root });
  const signal = new AbortController().signal;
  const query = async (...args: string[]) => {
    const result = await dispatch(['usage', ...args], signal);
    expect(result).toMatchObject({ kind: 'log', code: 0 });
    if (result.kind !== 'log') throw new Error('用量命令应返回日志');
    return result.lines.join('\n');
  };
  const project = await query();
  for (const text of [root, '项目', '已知输入 100', '已知输出 20', '已知缓存读 5', '已知缓存写 3', '已知费用估算 0.000159', '未知调用 1', '统计不完整', '命令', '角色', '模型', 'mock:p', '无法读取用量记录']) expect(project).toContain(text);
  expect(await query('--session')).toContain(currentId);
  expect(await query('--session')).not.toContain('mock:x');
  expect(await query('--session', otherId)).toContain(otherId);
  expect(await query('--session', otherId)).not.toContain('mock:p');
  for (const args of [['--project', root], ['--session', 'bad'], ['--session', ''], ['--session', otherId, 'extra'], [otherId]]) {
    expect(await dispatch(['usage', ...args], signal)).toMatchObject({ kind: 'log', code: 2 });
  }
});

it('/usage 对项目与模型名中的终端和 Unicode 控制字符作单行转义', async () => {
  const { root } = await createProject();
  const home = path.join(root, 'user');
  const id = randomUUID();
  const tail = '值\n\u001b\u0085\u061c\u200f\u2028\u2029\u202e\u2067';
  const encoded = '值' + ['000a', '001b', '0085', '061c', '200f', '2028', '2029', '202e', '2067'].map(code => '\\u' + code).join('') + '结束';
  await createUsageObserver({ project: root, home, sessionId: id, command: 'chat', role: 'planner', pricing: {}, warn: () => {} })({ ref: `mock:${tail}结束`, status: 'error', purpose: 'request', usage: null });
  const dispatch = createSlashDispatcher({ userConfigHome: home }, { currentId: id, project: root });
  const result = await dispatch(['usage'], new AbortController().signal);
  if (result.kind !== 'log') throw new Error('用量命令应返回日志');
  expect(result.lines.some(line => line.includes(`mock:${encoded}`))).toBe(true);
  const badProject = createSlashDispatcher({ userConfigHome: home }, { currentId: id, project: `${root}/${tail}结束` });
  const query = await badProject(['usage'], new AbortController().signal);
  expect(query).toMatchObject({ kind: 'log', lines: expect.arrayContaining([expect.stringContaining(encoded)]) });
});

it('跨项目 /init 仅写目标项目账本，启动项目 /usage 不混入该事件', async () => {
  const { root } = await createProject();
  const target = await createProject();
  const home = path.join(root, 'user');
  const currentId = randomUUID();
  const model = scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown: '# 项目笔记' } }] }]);
  const dispatch = createSlashDispatcher({ userConfigHome: home, modelOptions: { env: {}, factories: { openai: () => model } } }, { currentId, project: root });
  const signal = new AbortController().signal;
  expect(await dispatch(['init', '--project', target.root], signal)).toMatchObject({ kind: 'log', code: 0 });
  expect(await usageEvents(target.root, home)).toEqual([expect.objectContaining({ sessionId: currentId, command: 'init', role: 'extractor' })]);
  expect((await readUsage({ project: root, home })).total.calls).toBe(0);
  expect(await dispatch(['usage', '--session'], signal)).toMatchObject({ kind: 'log', code: 0, lines: expect.arrayContaining([expect.stringContaining('调用 0')]) });
});

it('会话命令清单覆盖全部斜杠命令且带描述', () => {
  expect(sessionSlashCommands.map((command) => command.name)).toEqual(['init', 'profile', 'reqs', 'plan', 'review', 'run', 'report', 'impact', 'status', 'usage', 'help', 'clear', 'exit']);
  expect(sessionSlashCommands.find((command) => command.name === 'init')?.description).toContain('笔记');
  expect(sessionSlashCommands.find((command) => command.name === 'profile')?.description).toContain('画像');
  expect(sessionSlashCommands.find((command) => command.name === 'review')?.description).toContain('笔记');
  for (const command of sessionSlashCommands) expect(command.description.length).toBeGreaterThan(0);
});

it('profile 斜杠命令交给 CLI 并执行笔记确认门禁', async () => {
  const { root } = await createProject();
  const dispatch = createSlashDispatcher({});
  const result = await dispatch(['profile', '--project', root], new AbortController().signal);
  expect(result).toMatchObject({ kind: 'log', code: 2, lines: expect.arrayContaining([expect.stringContaining('笔记尚未确认')]) });
});

it('审核参数保留项目路径并校验错误参数', async () => {
  const dispatch = createSlashDispatcher({});
  const signal = new AbortController().signal;
  expect(await dispatch(['review', 'cases', '--project', 'my project'], signal)).toMatchObject({ kind: 'review', args: { project: 'my project', view: 'cases' } });
  expect(await dispatch(['review', '--run', 'bad'], signal)).toMatchObject({ kind: 'log', code: 2 });
});
