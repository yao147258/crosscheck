import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { Approvals, loadProfile } from '@crosscheck/core';
import { ReviewSession } from '../src/io/session';
import { SessionApp, type RunSessionOptions } from '../src/session';
import { cleanupProjects, createProject } from './fixture';
import { deferred, KEYS, waitFor } from './helpers';

const exit = vi.hoisted(() => vi.fn());
vi.mock('ink', async (importOriginal) => {
  const ink = await importOriginal<typeof import('ink')>();
  return { ...ink, useApp: () => ({ ...ink.useApp(), exit }) };
});

afterEach(async () => { cleanup(); exit.mockReset(); await cleanupProjects(); });
const editor = { async edit() { throw new Error('unused'); } };
const open = async () => {};
const frame = (ui: ReturnType<typeof render>) => ui.lastFrame() ?? '';

it('启动时展示版本与各角色模型并过滤控制字符', () => {
  const options: RunSessionOptions = { info: { version: '1.2.3', models: { extractor: 'mock:extract', planner: 'mock:plan', executor: 'mock:execute', reviewer: 'mock:review\u001b' } }, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  for (const value of ['1.2.3', 'extractor', 'mock:extract', 'planner', 'mock:plan', 'executor', 'mock:execute', 'reviewer', 'mock:review']) expect(frame(ui)).toContain(value);
  expect(frame(ui)).not.toContain('\u001b');
});

it('未配置模型时启动界面显示未配置', () => {
  const options: RunSessionOptions = { info: { version: '1.2.3', models: undefined }, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  expect(frame(ui)).toContain('未配置');
});

it('短对话输入区紧随消息并响应高度变化', async () => {
  const options: RunSessionOptions = { tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '助手回复' };
  const ui = render(<SessionApp options={options} />);
  Object.defineProperty(ui.stdout, 'rows', { value: 12, configurable: true });
  ui.stdout.emit('resize');
  ui.stdin.write('用户消息'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('助手回复'));
  expect(frame(ui)).toContain('用户消息');
  expect(frame(ui)).not.toContain('你：');
  expect(frame(ui)).not.toContain('助手：');
  let lines = frame(ui).split('\n');
  expect(lines.findIndex(line => line.includes('>'))).toBe(lines.findIndex(line => line.includes('助手回复')) + 2);
  expect(lines.findIndex(line => line.includes('>'))).toBeLessThan(11);
  Object.defineProperty(ui.stdout, 'rows', { value: 8, configurable: true });
  ui.stdout.emit('resize');
  await waitFor(() => frame(ui).includes('助手回复'));
  lines = frame(ui).split('\n');
  expect(lines.findIndex(line => line.includes('>'))).toBe(lines.findIndex(line => line.includes('助手回复')) + 2);
});

it.skipIf(process.env.FORCE_COLOR !== '3')('输入区使用白色边线且不使用灰色背景', async () => {
  const options: RunSessionOptions = { tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '回答' };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('用户消息'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('用户消息'));
  const output = frame(ui);
  expect(output).toMatch(/\x1b\[48;2;211;211;211m[^\n]*用户消息/);
  const inputLine = output.split('\n').find(line => line.includes('>')) ?? '';
  expect(inputLine).not.toContain('\x1b[48;2;211;211;211m');
  expect(output).toMatch(/\x1b\[37m[^\n]*─/);
});

it('长回复超出终端高度时仍显示最新内容和底部输入区', async () => {
  const options: RunSessionOptions = { tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => Array.from({ length: 30 }, (_, i) => `回复行${i}`).join('\n') };
  const ui = render(<SessionApp options={options} />);
  Object.defineProperty(ui.stdout, 'rows', { value: 8, configurable: true });
  ui.stdout.emit('resize');
  ui.stdin.write('你好'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('回复行29'));
  expect(frame(ui)).not.toContain('回复行0');
  expect(frame(ui).split('\n')).toHaveLength(8);
  expect(frame(ui).split('\n').at(-2)).toContain('>');
  expect(frame(ui).split('\n').at(-1)).toContain('─');
});

it('审核退出返回聊天并重新解析会话', async () => {
  const project = await createProject();
  const resolveReview = vi.fn(async () => ({ session: project.session, editor, open }));
  const options: RunSessionOptions = { tokenize: (text) => text.split(' '), runSlashCommand: async () => ({ kind: 'review', args: { project: project.root, view: 'profile' } }), resolveReview, chatReply: async () => '回答' };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('/review'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('environments.yaml'));
  ui.stdin.write('q');
  await waitFor(() => frame(ui).includes('交互会话'));
  ui.stdin.write('/review'); ui.stdin.write(KEYS.enter);
  await waitFor(() => resolveReview.mock.calls.length === 2);
});

it('外部取消等待审核写盘完成后才退出', async () => {
  const { session, artifacts, root } = await createProject();
  const gate = deferred<void>(), entered = deferred<void>();
  const write = artifacts.writeJson.bind(artifacts);
  vi.spyOn(artifacts, 'writeJson').mockImplementation(async (...args) => { entered.resolve(); await gate.promise; return write(...args); });
  const controller = new AbortController();
  const options: RunSessionOptions = { signal: controller.signal, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'review', args: { project: root, view: 'profile' } }), resolveReview: async () => ({ session, editor, open }), chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('/review'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('environments.yaml'));
  ui.stdin.write('a'); await entered.promise;
  controller.abort();
  await waitFor(() => frame(ui).includes('等待当前操作完成'));
  expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')).toBeUndefined();
  gate.resolve();
  await waitFor(() => frame(ui).includes('交互会话') || frame(ui).includes('等待当前操作完成'));
  await waitFor(asyncCheck(() => Approvals.load(artifacts).then(a => Boolean(a.record('profile', 'environments.yaml')))));
});

it('会话显示去除不可信文本中的终端控制字符并保留换行', async () => {
  const payload = '甲\u001b]52;c;SGVsbG8=\u0007乙\u009b丙\u0000丁\n戊';
  const options: RunSessionOptions = { tokenize: text => [text], runSlashCommand: async () => ({ kind: 'log', code: 0, lines: [payload] }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => payload };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('hello'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('丁\n戊'));
  expect(frame(ui)).toContain('丁\n戊');
  expect(frame(ui)).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  ui.stdin.write('/log'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('退出码 0'));
  expect(frame(ui)).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(ui.frames.join('')).not.toContain('\u001b]52;');
});

it('显示用户输入和错误时过滤控制字符，但不改变提交的原文', async () => {
  const chatReply = vi.fn(async (_history: unknown, _text: string) => { throw new Error('失败\u009b隐藏\u0000文本'); });
  const options: RunSessionOptions = { tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('用户\u009b输入');
  await waitFor(() => frame(ui).includes('用户输入'));
  expect(frame(ui)).not.toContain('\u009b');
  ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('失败隐藏文本'));
  expect(frame(ui)).toContain('用户输入');
  expect(frame(ui)).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(chatReply.mock.calls[0]?.[1]).toBe('用户\u009b输入');
});

it('外部中断的正常取消保持退出码二', async () => {
  const entered = deferred<void>(), gate = deferred<void>();
  const controller = new AbortController();
  const options: RunSessionOptions = { signal: controller.signal, tokenize: text => [text], runSlashCommand: async (_tokens, signal) => { entered.resolve(); await gate.promise; signal.throwIfAborted(); return { kind: 'exit' }; }, resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('/plan'); ui.stdin.write(KEYS.enter); await entered.promise;
  controller.abort(); gate.resolve();
  await waitFor(() => exit.mock.calls.length > 0);
  expect(exit).toHaveBeenCalledWith(2);
});

it('外部中断审核等待结束后传播写盘错误', async () => {
  const { session, artifacts, root } = await createProject();
  const entered = deferred<void>(), gate = deferred<void>();
  const failure = new Error('写盘失败');
  vi.spyOn(artifacts, 'writeJson').mockImplementation(async () => { entered.resolve(); await gate.promise; throw failure; });
  const controller = new AbortController();
  const options: RunSessionOptions = { signal: controller.signal, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'review', args: { project: root, view: 'profile' } }), resolveReview: async () => ({ session, editor, open }), chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('/review'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('environments.yaml'));
  ui.stdin.write('a'); await entered.promise;
  controller.abort(); gate.resolve();
  await waitFor(() => exit.mock.calls.length > 0);
  expect(exit).toHaveBeenCalledWith(failure);
});

it('外部中断操作等待结束后传播非取消错误', async () => {
  const entered = deferred<void>(), gate = deferred<void>();
  const failure = new Error('宿主失败');
  const controller = new AbortController();
  const options: RunSessionOptions = { signal: controller.signal, tokenize: text => [text], runSlashCommand: async () => { entered.resolve(); await gate.promise; throw failure; }, resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('/plan'); ui.stdin.write(KEYS.enter); await entered.promise;
  controller.abort(); gate.resolve();
  await waitFor(() => exit.mock.calls.length > 0);
  expect(exit).toHaveBeenCalledWith(failure);
});

function asyncCheck(check: () => Promise<boolean>): () => boolean {
  let done = false;
  return () => { void check().then(value => { done ||= value; }); return done; };
}

it('每次重新打开审核读取最新确认记录', async () => {
  const { artifacts } = await createProject();
  const first = await ReviewSession.open(artifacts, '甲');
  const approvals = Approvals.empty();
  const profile = await loadProfile(artifacts);
  approvals.approve('profile', 'environments.yaml', profile['environments.yaml'], '乙');
  await approvals.save(artifacts);
  const second = await ReviewSession.open(artifacts, '甲');
  expect(first.approvals.record('profile', 'environments.yaml')).toBeUndefined();
  expect(second.approvals.record('profile', 'environments.yaml')?.by).toBe('乙');
});

it('中断任务后等待清理，不接收重复输入并允许后续任务', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const runSlashCommand = vi.fn(async (_tokens: string[], signal: AbortSignal) => {
    entered.resolve(); await release.promise; signal.throwIfAborted();
    return { kind: 'log' as const, code: 0, lines: [] };
  });
  const options: RunSessionOptions = { tokenize: (text) => [text], runSlashCommand, resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '回答' };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('/plan'); ui.stdin.write(KEYS.enter); await entered.promise;
  ui.stdin.write('\u0003'); ui.stdin.write('/again'); ui.stdin.write(KEYS.enter);
  expect(runSlashCommand).toHaveBeenCalledTimes(1);
  release.resolve();
  await waitFor(() => frame(ui).includes('操作已中断'));
  ui.stdin.write('hello'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('回答'));
});
