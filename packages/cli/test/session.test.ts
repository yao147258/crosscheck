import { expect, it, vi } from 'vitest';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach } from 'vitest';
import { APICallError } from 'ai';
import { ReviewSession, approveClause } from '@crosscheck/tui';
import { AUTO_REVIEWER, readProfileFile } from '@crosscheck/core';
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

it('status 保留摘要，只列当前已确认画像及可见转义后的确认人，不改写记录', async () => {
  const { root, artifacts, session } = await createProject();
  const reviewer = String.fromCodePoint(0x202e, 0x200d, 0xe0001) + '\\u000a人\n名\r\t\x1b\x7f\x9b\u2028末';
  await session.mutate(async (approvals) => {
    for (const [name, by] of [['pages.yaml', AUTO_REVIEWER], ['auth.yaml', reviewer], ['guardrails.yaml', '旧确认人']] as const) {
      const file = await readProfileFile(artifacts, name);
      if (!file.present || !file.ok) throw new Error(`画像无效：${name}`);
      approvals.approve('profile', name, file.value, by);
    }
  });
  await artifacts.writeYaml('system/guardrails.yaml', { allowedHosts: ['localhost:40000'] });
  const before = await artifacts.readBytes('approvals.json');
  const result = await createSlashDispatcher({ env: { CROSSCHECK_REVIEWER: 'auto' } })(['status', '--project', root], new AbortController().signal);
  expect(result).toMatchObject({ kind: 'log', code: 0 });
  if (result.kind !== 'log') throw new Error('状态命令应返回日志');
  expect(result.lines).toEqual(expect.arrayContaining([
    expect.stringContaining('当前阶段'), expect.stringContaining('画像：5 / 7'), expect.stringContaining('上一次测试'),
    expect.stringMatching(/pages\.yaml.*auto/),
    expect.stringContaining('\\u202e\\u200d\\u{e0001}\\\\u000a人\\u000a名\\u000d\\u0009\\u001b\\u007f\\u009b\\u2028末'),
  ]));
  expect(result.lines.find((line) => line.includes('auth.yaml'))).toContain('人\\u000a名');
  expect(result.lines.join('\n')).not.toMatch(/guardrails\.yaml|fixtures\.yaml|旧确认人|[\r\t\x1b\x7f\x9b\u2028]/);
  expect(await artifacts.readBytes('approvals.json')).toEqual(before);
});

it('会话命令清单覆盖全部斜杠命令且带描述', () => {
  expect(sessionSlashCommands.map((command) => command.name)).toEqual(['init', 'profile', 'reqs', 'plan', 'review', 'run', 'report', 'impact', 'status', 'help', 'clear', 'exit']);
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
