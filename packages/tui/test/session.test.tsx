import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { Approvals, loadProfile } from '@crosscheck/core';
import { sessionSlashCommands, tokenizeCommand } from '../../cli/src/session';
import { ReviewSession } from '../src/io/session';
import { SessionApp, type RunSessionOptions } from '../src/session';
import { cleanupProjects, createProject } from './fixture';
import { deferred, KEYS, renderInteractive, waitFor } from './helpers';

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

it('宽终端启动时展示 ASCII 标识，窄终端降级为简洁名称', async () => {
  const options: RunSessionOptions = { info: { version: '1.2.3', models: undefined }, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  Object.defineProperty(ui.stdout, 'columns', { value: 100, configurable: true });
  Object.defineProperty(ui.stdout, 'rows', { value: 30, configurable: true });
  ui.stdout.emit('resize');
  await waitFor(() => frame(ui).includes('  ____ ____   ___  ____ ____   ____ _   _ _____ ____ _  __'));
  expect(frame(ui)).toContain('Crosscheck 交互会话 · v1.2.3');
  Object.defineProperty(ui.stdout, 'columns', { value: 24, configurable: true });
  ui.stdout.emit('resize');
  await waitFor(() => !frame(ui).includes('  ____ ____   ___  ____ ____   ____ _   _ _____ ____ _  __'));
  expect(frame(ui)).toContain('Crosscheck');
  expect(frame(ui)).toContain('1.2.3');
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

it.skipIf(process.env.FORCE_COLOR !== '3')('用户消息与输入区使用浅灰背景并保留白色边线', async () => {
  const options: RunSessionOptions = { tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '回答' };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('用户消息'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('用户消息'));
  const output = frame(ui);
  expect(output).toMatch(/\x1b\[48;2;184;184;184m[^\n]*用户消息/);
  expect(output).toMatch(/\x1b\[48;2;184;184;184m[^\n]*>/);
  expect(output).toContain('\x1b[30m');
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

const completionCommands = [
  { name: 'reqs', description: '提取条款草稿' },
  { name: 'review', description: '交互审核' },
  { name: 'exit', description: '退出会话' },
];
const completionOptions = (overrides?: Partial<RunSessionOptions>): RunSessionOptions => ({ slashCommands: completionCommands, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '', ...overrides });
// ink 的 useInput 在挂载后才订阅 stdin，首次写入前需让事件循环先转一圈。
const mounted = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

it('输入斜杠前缀时在输入框下方显示匹配命令与描述', async () => {
  const ui = render(<SessionApp options={completionOptions()} />);
  await mounted();
  ui.stdin.write('/');
  await waitFor(() => frame(ui).includes('/exit 退出会话'));
  expect(frame(ui)).toContain('/reqs 提取条款草稿');
  expect(frame(ui)).toContain('/review 交互审核');
  ui.stdin.write('r');
  await waitFor(() => frame(ui).includes('/review 交互审核') && !frame(ui).includes('/exit 退出会话'));
  expect(frame(ui)).toContain('/reqs 提取条款草稿');
  const lines = frame(ui).split('\n');
  // 提示列表位于输入框下方。
  expect(lines.findIndex(line => line.includes('/reqs'))).toBeGreaterThan(lines.findIndex(line => line.includes('> /r')));
});

it('输入非斜杠文本时不显示命令提示', async () => {
  const ui = render(<SessionApp options={completionOptions()} />);
  await mounted();
  ui.stdin.write('hello');
  await waitFor(() => frame(ui).includes('> hello'));
  expect(frame(ui)).not.toContain('/reqs 提取条款草稿');
});

it('Tab 在匹配命令间循环补全', async () => {
  const ui = render(<SessionApp options={completionOptions()} />);
  await mounted();
  ui.stdin.write('/r');
  await waitFor(() => frame(ui).includes('> /r'));
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /reqs'));
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /review'));
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /reqs'));
});

it('真实命令清单中 /profile 可提示、补全并提交', async () => {
  const runSlashCommand = vi.fn(async (_tokens: string[]) => ({ kind: 'log' as const, code: 0, lines: ['画像命令完成'] }));
  const options = completionOptions({ slashCommands: sessionSlashCommands, tokenize: tokenizeCommand, runSlashCommand });
  const ui = render(<SessionApp options={options} />);
  await mounted();
  ui.stdin.write('/pro');
  await waitFor(() => frame(ui).includes('/profile 根据已确认笔记生成画像草稿'));
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /profile'));
  ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('画像命令完成'));
  expect(runSlashCommand.mock.calls[0]?.[0]).toEqual(['profile']);
});

it('非斜杠输入按 Tab 不修改输入内容', async () => {
  const ui = render(<SessionApp options={completionOptions()} />);
  await mounted();
  ui.stdin.write('abc');
  await waitFor(() => frame(ui).includes('> abc'));
  ui.stdin.write(KEYS.tab);
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(frame(ui)).toContain('> abc');
});

it('补全后继续编辑会重置循环顺序', async () => {
  const ui = render(<SessionApp options={completionOptions()} />);
  await mounted();
  ui.stdin.write('/r');
  await waitFor(() => frame(ui).includes('> /r'));
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /reqs'));
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /review'));
  // 退格回到裸斜杠：三个命令都匹配；若循环未重置会从 index 1 选中 /review。
  for (let i = 0; i < '/review'.length - 1; i++) ui.stdin.write('\u007f');
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /reqs'));
});

it('空闲时终端光标定位到输入框内', async () => {
  const ui = renderInteractive(<SessionApp options={completionOptions()} />);
  await mounted();
  ui.stdin.write('hi');
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  // 显示光标并定位到提示符与输入文本之后（debug=false 才产生光标转义）。
  expect(ui.writes()).toContain('\u001B[?25h');
  expect(ui.writes()).toMatch(/\u001B\[\d+A\u001B\[\d+G\u001B\[\?25h/);
  ui.unmount();
});

it('执行中隐藏终端光标，结束后重新显示', async () => {
  const release = deferred<void>();
  const chatReply = vi.fn(async () => { await release.promise; return '回答'; });
  const ui = renderInteractive(<SessionApp options={completionOptions({ chatReply })} />);
  await mounted();
  ui.stdin.write('问题'); ui.stdin.write(KEYS.enter);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  const writes = ui.writes();
  expect(writes.indexOf('\u001B[?25h')).toBeGreaterThan(-1);
  expect(writes.indexOf('\u001B[?25l')).toBeGreaterThan(writes.indexOf('\u001B[?25h'));
  release.resolve();
  ui.unmount();
});

it('clear 指令清空对话消息与模型历史', async () => {
  const chatReply = vi.fn(async (_history: unknown[], _text: string) => '回答');
  const runSlashCommand = vi.fn(async () => ({ kind: 'clear' as const }));
  const ui = render(<SessionApp options={completionOptions({ runSlashCommand, chatReply })} />);
  await mounted();
  ui.stdin.write('第一句'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('回答'));
  ui.stdin.write('/clear'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('已清空对话历史'));
  expect(frame(ui)).not.toContain('第一句');
  expect(frame(ui)).not.toContain('/clear');
  ui.stdin.write('第二句'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('回答'));
  expect(chatReply.mock.calls[0]?.[0]).toEqual([]);
  expect(chatReply.mock.calls[1]?.[0]).toEqual([]);
});
