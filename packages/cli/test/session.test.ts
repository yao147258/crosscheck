import { expect, it, vi } from 'vitest';
import { afterEach } from 'vitest';
import { APICallError } from 'ai';
import { ReviewSession, approveClause } from '@crosscheck/tui';
import { clause } from '../../tui/test/fixture';
import { scriptedModel } from '../../agent/src/testing/scripted-model';
import { cleanupProjects, createProject } from '../../tui/test/fixture';
import { chatReply, createSlashDispatcher, loadSessionInfo, tokenizeCommand } from '../src/session';
import cliPackage from '../package.json';

afterEach(async () => { vi.restoreAllMocks(); await cleanupProjects(); });

it('聊天无需确认人或审核会话，读取已有确认且不写入确认记录', async () => {
  const { root, artifacts, session } = await createProject();
  await artifacts.saveClauses('M', [clause(1), clause(2)]);
  await approveClause(session, 'M', 'M-AC-1');
  const before = await artifacts.readBytes('approvals.json');
  const open = vi.spyOn(ReviewSession, 'open').mockRejectedValue(new Error('聊天不能打开审核会话'));
  const model = scriptedModel([{ text: '只读回答' }]);
  const reply = await chatReply(root, [], '还有多少', { env: {}, modelOptions: { env: {}, factories: { ollama: () => model } } }, new AbortController().signal);
  expect(reply).toBe('只读回答');
  expect(open).not.toHaveBeenCalled();
  expect(model.doGenerateCalls[0]!.prompt[0]).toMatchObject({ role: 'system', content: expect.stringContaining('"clausesPending":1') });
  expect(await artifacts.readBytes('approvals.json')).toEqual(before);
});

it('可重试模型错误只由 fallback 控制重试次数', async () => {
  const { root } = await createProject();
  const error = new APICallError({ message: '服务不可用', url: 'https://example.test', requestBodyValues: {}, statusCode: 503, isRetryable: true });
  const model = scriptedModel([{ error }, { text: '不应重试' }]);
  await expect(chatReply(root, [], '你好', { resilience: { retries: 0 }, modelOptions: { env: {}, factories: { ollama: () => model } } }, new AbortController().signal)).rejects.toThrow();
  expect(model.doGenerateCalls).toHaveLength(1);
});

it('聊天首次读取摘要并回退模型，不授予工具且保留历史', async () => {
  const { root, artifacts } = await createProject();
  await artifacts.writeYaml('config.yaml', { models: { extractor: 'mock:x', planner: 'mock:primary', executor: 'mock:e', reviewer: 'mock:r', fallback: { planner: 'mock:backup' } }, providers: { mock: { type: 'ollama' } } });
  const primary = scriptedModel([{ error: new Error('模型故障') }]);
  const backup = scriptedModel([{ text: '只读回答' }]);
  const reply = await chatReply(root, [{ role: 'user', content: '上个问题' }, { role: 'assistant', content: '上个回答' }], '还有多少', { resilience: { retries: 0 }, modelOptions: { env: {}, factories: { ollama: ({ modelId }) => modelId === 'primary' ? primary : backup } } }, new AbortController().signal);
  expect(reply).toBe('只读回答');
  const call = backup.doGenerateCalls[0]!;
  expect(call.tools ?? []).toHaveLength(0);
  expect(JSON.stringify(call.prompt)).toContain('profilePending');
  expect(JSON.stringify(call.prompt)).toContain('上个问题');
  expect(JSON.stringify(call.prompt)).toContain('不可执行写入或确认');
});

it('缺少模型配置时聊天显示错误且不影响命令分发', async () => {
  const { root, artifacts } = await createProject();
  await artifacts.writeYaml('config.yaml', {});
  const signal = new AbortController().signal;
  await expect(chatReply(root, [], '你好', {}, signal)).rejects.toThrow();
  expect(await createSlashDispatcher({})(['help'], signal)).toMatchObject({ kind: 'log', code: 0 });
});

it('启动信息读取项目模型配置和 CLI 版本', async () => {
  const { root } = await createProject();
  expect(await loadSessionInfo(root)).toEqual({ version: cliPackage.version, models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' } });
});

it('配置文件不存在时启动信息不阻止会话', async () => {
  const { root } = await createProject();
  const { unlink } = await import('node:fs/promises');
  await unlink(new (await import('@crosscheck/core')).ArtifactStore(root).resolve('config.yaml'));
  expect(await loadSessionInfo(root)).toEqual({ version: cliPackage.version, models: undefined });
});

it('配置无效时启动信息不阻止会话', async () => {
  const { root, artifacts } = await createProject();
  await artifacts.writeYaml('config.yaml', {});
  expect(await loadSessionInfo(root)).toEqual({ version: cliPackage.version, models: undefined });
});

it('识别引号包围的含空格项目路径', () => {
  expect(tokenizeCommand('review cases --project "my project"')).toEqual(['review', 'cases', '--project', 'my project']);
  expect(() => tokenizeCommand('review "unterminated')).toThrow();
});

it('空斜杠不会递归启动会话', async () => {
  const dispatch = createSlashDispatcher({});
  expect(await dispatch([], new AbortController().signal)).toMatchObject({ kind: 'log', code: 2 });
});

it('审核参数保留项目路径并校验错误参数', async () => {
  const dispatch = createSlashDispatcher({});
  const signal = new AbortController().signal;
  expect(await dispatch(['review', 'cases', '--project', 'my project'], signal)).toMatchObject({ kind: 'review', args: { project: 'my project', view: 'cases' } });
  expect(await dispatch(['review', '--run', 'bad'], signal)).toMatchObject({ kind: 'log', code: 2 });
});
