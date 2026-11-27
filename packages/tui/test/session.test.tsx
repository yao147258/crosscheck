import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { Approvals, ArtifactStore, loadProfile, readProfileFiles } from '@crosscheck/core';
import type { CommandDependencies } from '../../cli/src/context';
import { createSlashDispatcher, sessionCommand, sessionSlashCommands, tokenizeCommand } from '../../cli/src/session';
import * as tui from '../src/index';
import { scriptedModel } from '../../agent/src/testing/scripted-model';
import { createUsageObserver, projectUsageLocation, readUsage } from '../../models/src/usage-ledger';
import { writeFile } from 'node:fs/promises';
import { SessionStore } from '../../cli/src/session-store';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { ReviewSession } from '../src/io/session';
import { SessionApp, type RunSessionOptions } from '../src/session';
import { cleanupProjects, createProject } from './fixture';
import { deferred, KEYS, renderInteractive, terminalSnapshot, waitFor } from './helpers';

vi.mock('node:fs/promises', { spy: true });
const exit = vi.hoisted(() => vi.fn());
vi.mock('ink', async (importOriginal) => {
  const ink = await importOriginal<typeof import('ink')>();
  return { ...ink, useApp: () => ({ ...ink.useApp(), exit }) };
});

afterEach(async () => { cleanup(); exit.mockReset(); await cleanupProjects(); });
const editor = { async edit() { throw new Error('unused'); } };
const open = async () => {};
const noUsage = { resetSession: () => {}, loadSessionUsage: async () => '' };
const frame = (ui: ReturnType<typeof render>) => ui.lastFrame() ?? '';
// 终端显示宽度：CJK 等全角字符按 2 列计。
const displayWidth = (line: string) => [...line.trimEnd()].reduce((sum, ch) => sum + ((ch.codePointAt(0) ?? 0) >= 0x1100 && !/[─-╿]/.test(ch) ? 2 : 1), 0);

it('启动时展示版本与各角色模型并过滤控制字符', () => {
  const options: RunSessionOptions = { ...noUsage,info: { version: '1.2.3', models: { extractor: 'mock:extract', planner: 'mock:plan', executor: 'mock:execute', reviewer: 'mock:review\u001b' } }, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  for (const value of ['1.2.3', 'extractor', 'mock:extract', 'planner', 'mock:plan', 'executor', 'mock:execute', 'reviewer', 'mock:review']) expect(frame(ui)).toContain(value);
  expect(frame(ui)).not.toContain('\u001b');
});

it('宽终端启动时展示 ASCII 标识，窄终端降级为简洁名称', async () => {
  const options: RunSessionOptions = { ...noUsage,info: { version: '1.2.3', models: undefined }, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  Object.defineProperty(ui.stdout, 'columns', { value: 100, configurable: true });
  Object.defineProperty(ui.stdout, 'rows', { value: 30, configurable: true });
  ui.stdout.emit('resize');
  await waitFor(() => frame(ui).includes('  ____ ____   ___  ____ ____   ____ _   _ _____ ____ _  __'));
  expect(frame(ui)).toContain('AI Agent Command Line Client');
  Object.defineProperty(ui.stdout, 'columns', { value: 24, configurable: true });
  ui.stdout.emit('resize');
  await waitFor(() => !frame(ui).includes('  ____ ____   ___  ____ ____   ____ _   _ _____ ____ _  __'));
  expect(frame(ui)).toContain('Crosscheck');
  expect(frame(ui)).toContain('1.2.3');
});

it('未配置模型时启动界面显示未配置', () => {
  const options: RunSessionOptions = { ...noUsage,info: { version: '1.2.3', models: undefined }, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  expect(frame(ui)).toContain('未配置');
});

it('短对话输入区紧随消息并响应高度变化', async () => {
  const options: RunSessionOptions = { ...noUsage,tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '助手回复' };
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
  const options: RunSessionOptions = { ...noUsage,tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '回答' };
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
  const options: RunSessionOptions = { ...noUsage,tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => Array.from({ length: 30 }, (_, i) => `回复行${i}`).join('\n') };
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

const longReply = (count: number): RunSessionOptions => ({ ...noUsage,tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => Array.from({ length: count }, (_, i) => `回复行${i}`).join('\n') });
const resize = (ui: ReturnType<typeof render>, rows: number) => {
  Object.defineProperty(ui.stdout, 'rows', { value: rows, configurable: true });
  ui.stdout.emit('resize');
};

it('PageUp/PageDown 按屏翻看历史并限制在边界内', async () => {
  const ui = render(<SessionApp options={longReply(30)} />);
  resize(ui, 8);
  ui.stdin.write('你好'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('回复行29'));
  ui.stdin.write(KEYS.pageUp);
  await waitFor(() => !frame(ui).includes('回复行29'));
  expect(frame(ui)).toContain('回复行24');
  for (let i = 0; i < 20; i++) ui.stdin.write(KEYS.pageUp);
  await waitFor(() => frame(ui).split('\n')[0]!.startsWith('  ____ ____'));
  ui.stdin.write(KEYS.pageDown);
  await waitFor(() => !frame(ui).split('\n')[0]!.startsWith('  ____ ____'));
  for (let i = 0; i < 20; i++) ui.stdin.write(KEYS.pageDown);
  await waitFor(() => frame(ui).includes('回复行29'));
  expect(frame(ui).split('\n').at(-2)).toContain('>');
});

it('没有命令候选时 ↑/↓ 逐行滚动历史', async () => {
  const ui = render(<SessionApp options={longReply(30)} />);
  resize(ui, 8);
  ui.stdin.write('你好'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('回复行29'));
  ui.stdin.write(KEYS.up);
  await waitFor(() => !frame(ui).includes('回复行29'));
  expect(frame(ui)).toContain('回复行28');
  ui.stdin.write(KEYS.down);
  await waitFor(() => frame(ui).includes('回复行29'));
});

it('鼠标滚轮翻看历史且不写入输入框', async () => {
  const ui = render(<SessionApp options={longReply(30)} />);
  resize(ui, 8);
  ui.stdin.write('你好'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('回复行29'));
  ui.stdin.write('\u001b[<64;10;3M');
  await waitFor(() => !frame(ui).includes('回复行27'));
  expect(frame(ui)).toContain('回复行26');
  ui.stdin.write('\u001b[<65;10;3M');
  await waitFor(() => frame(ui).includes('回复行29'));
  expect(frame(ui)).not.toContain('[<');
});

it('执行中实时显示模型与工具提示，并允许翻看历史', async () => {
  const release = deferred<void>(), entered = deferred<void>();
  const runSlashCommand = vi.fn(async (_tokens: string[], _signal: AbortSignal, onProgress?: (text: string) => void) => {
    onProgress?.('[执行] 第 1 轮：请求模型 mock:a 思考下一步');
    onProgress?.('[执行] 调用工具 http_request（method=GET, path=/api/items）：发送请求');
    entered.resolve(); await release.promise;
    return { kind: 'log' as const, code: 0, lines: ['完成'] };
  });
  const ui = render(<SessionApp options={completionOptions({ runSlashCommand })} />);
  await mounted();
  ui.stdin.write('/run'); ui.stdin.write(KEYS.enter);
  await entered.promise;
  await waitFor(() => frame(ui).includes('调用工具 http_request'));
  expect(frame(ui)).toContain('请求模型 mock:a');
  expect(frame(ui)).toMatch(/执行中 \d+s/);
  release.resolve();
  await waitFor(() => frame(ui).includes('退出码 0'));
  expect(frame(ui)).not.toContain('调用工具 http_request');
});

it('翻看历史后提交新消息回到最新内容', async () => {
  const ui = render(<SessionApp options={longReply(30)} />);
  resize(ui, 8);
  ui.stdin.write('你好'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('回复行29'));
  ui.stdin.write(KEYS.pageUp);
  await waitFor(() => !frame(ui).includes('回复行29'));
  ui.stdin.write('再问'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('回复行29'));
});

it('内容超出视口时右侧显示滚动条，未超出时不显示', async () => {
  const ui = render(<SessionApp options={longReply(30)} />);
  resize(ui, 8);
  await waitFor(() => frame(ui).includes('>'));
  expect(frame(ui)).not.toMatch(/[╻┃╹]/);
  ui.stdin.write('你好'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('回复行29'));
  // 滑块贴最右列、两端圆角，不画轨道竖线。
  const bottom = frame(ui).split('\n').slice(0, -3);
  expect(bottom.at(-1)?.trimEnd()).toMatch(/[┃╹]$/);
  expect(displayWidth(bottom.at(-1)!)).toBe(100);
  expect(bottom[0]?.trimEnd()).not.toMatch(/[│╻┃╹]$/);
  ui.stdin.write(KEYS.pageUp); ui.stdin.write(KEYS.pageUp); ui.stdin.write(KEYS.pageUp); ui.stdin.write(KEYS.pageUp); ui.stdin.write(KEYS.pageUp); ui.stdin.write(KEYS.pageUp);
  await waitFor(() => frame(ui).includes('AI Agent Command Line Client'));
  const top = frame(ui).split('\n').slice(0, -3);
  expect(top[0]?.trimEnd()).toMatch(/[┃╻]$/);
  expect(top.at(-1)?.trimEnd()).not.toMatch(/[│╻┃╹]$/);
});

it('末行不写入终端最后一列，避免 Windows 控制台自动换行导致整屏上滚', async () => {
  const ui = render(<SessionApp options={longReply(30)} />);
  resize(ui, 8);
  ui.stdin.write('你好'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('回复行29'));
  const lines = frame(ui).split('\n');
  for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(100);
  expect(displayWidth(lines.at(-1)!)).toBeLessThan(100);
});

it('审核退出返回聊天并重新解析会话', async () => {
  const project = await createProject();
  const resolveReview = vi.fn(async () => ({ session: project.session, editor, open }));
  const options: RunSessionOptions = { ...noUsage,tokenize: (text) => text.split(' '), runSlashCommand: async () => ({ kind: 'review', args: { project: project.root, view: 'profile' } }), resolveReview, chatReply: async () => '回答' };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('/review'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('environments.yaml'));
  ui.stdin.write('q');
  await waitFor(() => frame(ui).includes('AI Agent Command Line Client'));
  ui.stdin.write('/review'); ui.stdin.write(KEYS.enter);
  await waitFor(() => resolveReview.mock.calls.length === 2);
});

it('外部取消等待审核写盘完成后才退出', async () => {
  const { session, artifacts, root } = await createProject();
  const gate = deferred<void>(), entered = deferred<void>();
  const write = artifacts.writeJson.bind(artifacts);
  vi.spyOn(artifacts, 'writeJson').mockImplementation(async (...args) => { entered.resolve(); await gate.promise; return write(...args); });
  const controller = new AbortController();
  const options: RunSessionOptions = { ...noUsage,signal: controller.signal, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'review', args: { project: root, view: 'profile' } }), resolveReview: async () => ({ session, editor, open }), chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('/review'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('environments.yaml'));
  ui.stdin.write('a'); await entered.promise;
  controller.abort();
  await waitFor(() => frame(ui).includes('等待当前操作完成'));
  expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')).toBeUndefined();
  gate.resolve();
  await waitFor(() => frame(ui).includes('AI Agent Command Line Client') || frame(ui).includes('等待当前操作完成'));
  await waitFor(asyncCheck(() => Approvals.load(artifacts).then(a => Boolean(a.record('profile', 'environments.yaml')))));
});

it('会话显示去除不可信文本中的终端控制字符并保留换行', async () => {
  const payload = '甲\u001b]52;c;SGVsbG8=\u0007乙\u009b丙\u0000丁\n戊';
  const options: RunSessionOptions = { ...noUsage,tokenize: text => [text], runSlashCommand: async () => ({ kind: 'log', code: 0, lines: [payload] }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => payload };
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
  const options: RunSessionOptions = { ...noUsage,tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply };
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
  const options: RunSessionOptions = { ...noUsage,signal: controller.signal, tokenize: text => [text], runSlashCommand: async (_tokens, signal) => { entered.resolve(); await gate.promise; signal.throwIfAborted(); return { kind: 'exit' }; }, resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '' };
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
  const options: RunSessionOptions = { ...noUsage,signal: controller.signal, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'review', args: { project: root, view: 'profile' } }), resolveReview: async () => ({ session, editor, open }), chatReply: async () => '' };
  const ui = render(<SessionApp options={options} />);
  ui.stdin.write('/review'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('environments.yaml'));
  ui.stdin.write('a'); await entered.promise;
  controller.abort(); gate.resolve();
  await waitFor(() => exit.mock.calls.length > 0);
  expect(exit).toHaveBeenCalledWith(expect.any(Error));
  expect(exit.mock.calls[0]![0]).not.toBe(failure);
});

it('外部中断操作等待结束后仅向 Ink 传播脱敏错误', async () => {
  const entered = deferred<void>(), gate = deferred<void>();
  const failure = new Error('宿主失败 fixture-key', { cause: new Error('fixture-key') });
  const controller = new AbortController();
  const { root } = await createProject();
  const { send, store, id } = await persistedSession(root, scriptedModel([]), controller.signal, async () => {
    entered.resolve(); await gate.promise; throw failure;
  });
  send('/plan'); await entered.promise;
  controller.abort(); gate.resolve();
  await waitFor(() => exit.mock.calls.length > 0);
  const reported = exit.mock.calls[0]![0];
  expect(reported).toBeInstanceOf(Error);
  expect(reported.message).toContain('宿主失败');
  expect(reported.stack).not.toContain('fixture-key');
  expect(reported.cause).toBeUndefined();
  expect(JSON.stringify(await store.load(id()!))).not.toContain('fixture-key');
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
  const options: RunSessionOptions = { ...noUsage,tokenize: (text) => [text], runSlashCommand, resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '回答' };
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
const completionOptions = (overrides?: Partial<RunSessionOptions>): RunSessionOptions => ({ ...noUsage,slashCommands: completionCommands, tokenize: text => [text], runSlashCommand: async () => ({ kind: 'exit' }), resolveReview: async () => { throw new Error('unused'); }, chatReply: async () => '', ...overrides });
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

it('Tab 补全当前高亮的候选（默认高亮第一项）', async () => {
  const ui = render(<SessionApp options={completionOptions()} />);
  await mounted();
  ui.stdin.write('/r');
  await waitFor(() => frame(ui).includes('> /r'));
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /reqs'));
});

it('↓ 切换高亮候选，Tab 补全高亮项', async () => {
  const ui = render(<SessionApp options={completionOptions()} />);
  await mounted();
  ui.stdin.write('/r');
  await waitFor(() => frame(ui).includes('> /r'));
  ui.stdin.write(KEYS.down);
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /review'));
});

it('↓ 在候选列表末尾后循环回第一项', async () => {
  const ui = render(<SessionApp options={completionOptions()} />);
  await mounted();
  ui.stdin.write('/r');
  await waitFor(() => frame(ui).includes('> /r'));
  ui.stdin.write(KEYS.down);
  ui.stdin.write(KEYS.down);
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /reqs'));
});

it('↑ 从默认高亮向上循环到最后一项', async () => {
  const ui = render(<SessionApp options={completionOptions()} />);
  await mounted();
  ui.stdin.write('/r');
  await waitFor(() => frame(ui).includes('> /r'));
  ui.stdin.write(KEYS.up);
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /review'));
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

it('补全后继续编辑会把高亮重置为第一项', async () => {
  const ui = render(<SessionApp options={completionOptions()} />);
  await mounted();
  ui.stdin.write('/r');
  await waitFor(() => frame(ui).includes('> /r'));
  ui.stdin.write(KEYS.down);
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /review'));
  // 退格回到裸斜杠：reqs/review 都匹配；若高亮未重置会仍选中 /review。
  for (let i = 0; i < '/review'.length - 1; i++) ui.stdin.write('\u007f');
  ui.stdin.write(KEYS.tab);
  await waitFor(() => frame(ui).includes('> /reqs'));
});

it('短对话下方留白时光标位于输入文本行而非下边框', async () => {
  const ui = renderInteractive(<SessionApp options={completionOptions()} />);
  try {
    await mounted();
    await waitFor(() => terminalSnapshot(ui.writes()).visible);
    let screen = terminalSnapshot(ui.writes());
    expect(screen.lines[screen.y]).toBe('>');
    expect(screen.x).toBe(2);
    ui.stdin.write('hi');
    await waitFor(() => terminalSnapshot(ui.writes()).lines.some(line => line === '> hi'));
    screen = terminalSnapshot(ui.writes());
    expect(screen.lines[screen.y]).toBe('> hi');
    expect(screen.x).toBe(4);
  } finally { ui.unmount(); }
});

it('满屏回复结束后光标仍在底部输入文本行', async () => {
  const ui = renderInteractive(<SessionApp options={longReply(30)} />);
  try {
    await mounted();
    ui.stdin.write('你好'); ui.stdin.write(KEYS.enter);
    await waitFor(() => terminalSnapshot(ui.writes()).lines.some(line => line.startsWith('回复行29')) && terminalSnapshot(ui.writes()).visible);
    const screen = terminalSnapshot(ui.writes());
    expect(screen.lines[screen.y]).toBe('>');
    expect(screen.y).toBe(22);
    expect(screen.x).toBe(2);
  } finally { ui.unmount(); }
});

it('命令候选出现与收起后光标保持在输入行', async () => {
  const ui = renderInteractive(<SessionApp options={completionOptions()} />);
  try {
    await mounted();
    ui.stdin.write('/');
    await waitFor(() => terminalSnapshot(ui.writes()).lines.includes('/exit 退出会话'));
    let screen = terminalSnapshot(ui.writes());
    expect(screen.lines[screen.y]).toBe('> /');
    expect(screen.x).toBe(3);
    Object.defineProperty(ui.stdout, 'rows', { value: 8, configurable: true });
    ui.stdout.emit('resize');
    await waitFor(() => terminalSnapshot(ui.writes(), 100, 8).lines[7] === '/exit 退出会话');
    screen = terminalSnapshot(ui.writes(), 100, 8);
    expect(screen.lines[screen.y]).toBe('> /');
    expect(screen.y).toBe(3);
    Object.defineProperty(ui.stdout, 'rows', { value: 40, configurable: true });
    ui.stdout.emit('resize');
    await waitFor(() => terminalSnapshot(ui.writes(), 100, 40).lines.slice(8).includes('/exit 退出会话'));
    screen = terminalSnapshot(ui.writes(), 100, 40);
    expect(screen.lines[screen.y]).toBe('> /');
    ui.stdin.write('\u007f');
    await waitFor(() => !terminalSnapshot(ui.writes(), 100, 40).lines.includes('/exit 退出会话'));
    screen = terminalSnapshot(ui.writes(), 100, 40);
    expect(screen.lines[screen.y]).toBe('>');
    expect(screen.x).toBe(2);
  } finally { ui.unmount(); }
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

it('启动会话在聊天和模型命令后刷新用量，跨项目命令不混入且清空换 ID', async () => {
  const { root } = await createProject();
  const target = await createProject();
  const home = path.join(root, 'user');
  const prompt = '会话提示词不得写入账本';
  const model = scriptedModel([{ text: '真实会话回复', usage: { cacheRead: 0 } }, { toolCalls: [{ name: 'finish', input: { markdown: '# 当前项目笔记' } }] }, { toolCalls: [{ name: 'finish', input: { markdown: '# 目标项目笔记' } }] }]);
  const run = vi.spyOn(tui, 'runSession').mockResolvedValue(0);
  try {
    await sessionCommand({ command: 'session', project: root, open: false }, () => {}, { userConfigHome: home, session: { isTTY: true }, modelOptions: { env: {}, factories: { openai: () => model } } });
    const ui = render(<SessionApp options={{ ...run.mock.calls[0]![0], mouseTracking: undefined }} />);
    resize(ui, 45);
    await mounted();
    const send = (input: string) => { ui.stdin.write(input); ui.stdin.write(KEYS.enter); };
    const id = () => /会话 ID：([a-f0-9-]{36})/.exec(frame(ui))?.[1];
    await waitFor(() => Boolean(id()) && frame(ui).includes('调用 0'));
    const oldId = id()!;
    send(prompt);
    await waitFor(() => frame(ui).includes('真实会话回复') && frame(ui).includes('调用 1'));
    send('/init');
    await waitFor(() => frame(ui).includes('退出码 0') && frame(ui).includes('调用 2'));
    send(`/init --project "${target.root}"`);
    await waitFor(() => (frame(ui).match(/退出码 0/g) ?? []).length === 2 && !frame(ui).includes('Ctrl+C 中断'));
    expect(frame(ui)).toContain('调用 2');
    expect((await readUsage({ project: target.root, home, sessionId: oldId })).total.calls).toBe(1);
    const { directory } = await projectUsageLocation(root, home);
    const contents = await Promise.all((await fs.readdir(directory)).map(file => fs.readFile(path.join(directory, file), 'utf8')));
    const events = contents.map(text => JSON.parse(text));
    const chatCalls = model.doGenerateCalls.filter(call => JSON.stringify(call.prompt).includes(prompt)).length;
    expect(chatCalls).toBe(1);
    expect(events.filter(event => event.command === 'chat')).toEqual([expect.objectContaining({
      sessionId: oldId, status: 'success', price: null, cost: null,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: null },
    })]);
    expect(new Set(events.map(event => event.id)).size).toBe(events.length);
    for (const privateText of ['fixture-key', prompt, '真实会话回复']) expect(contents.join('\n')).not.toContain(privateText);
    send('/clear');
    await waitFor(() => frame(ui).includes('已清空对话历史') && frame(ui).includes('调用 0') && Boolean(id()) && id() !== oldId);
    expect((await readUsage({ project: root, home })).total.calls).toBe(2);
    expect((await readUsage({ project: root, home, sessionId: id()! })).total.calls).toBe(0);
  } finally { run.mockRestore(); }
});

it('账本写入告警在操作结束后仍可见，恢复可读也不把缺失统计标成完整', async () => {
  const { root } = await createProject();
  const home = path.join(root, 'user');
  const { directory } = await projectUsageLocation(root, home);
  const originalMkdir = (await vi.importActual<typeof fs>('node:fs/promises')).mkdir;
  let blocked = true;
  const mkdir = vi.mocked(fs.mkdir).mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
    if (blocked && args[0] === directory) throw new Error('用量目录不可写');
    return originalMkdir(...args);
  }) as typeof fs.mkdir);
  const model = scriptedModel([{ text: '未丢失的回复' }, { toolCalls: [{ name: 'finish', input: { markdown: '# 告警后仍保存' } }] }]);
  const run = vi.spyOn(tui, 'runSession').mockResolvedValue(0);
  try {
    await sessionCommand({ command: 'session', project: root, open: false }, () => {}, { userConfigHome: home, session: { isTTY: true }, modelOptions: { env: {}, factories: { openai: () => model } } });
    const ui = render(<SessionApp options={{ ...run.mock.calls[0]![0], mouseTracking: undefined }} />);
    resize(ui, 40);
    await mounted();
    ui.stdin.write('问题'); ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('未丢失的回复') && !frame(ui).includes('Ctrl+C 中断'));
    expect(frame(ui)).toContain('用量记录写入失败');
    blocked = false;
    ui.stdin.write('/usage --session'); ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('退出码 0') && !frame(ui).includes('Ctrl+C 中断'));
    expect(frame(ui)).toMatch(/调用 0[^\n]*统计不完整/);
    blocked = true;
    ui.stdin.write('/init'); ui.stdin.write(KEYS.enter);
    await waitFor(() => (frame(ui).match(/退出码 0/g) ?? []).length === 2 && !frame(ui).includes('Ctrl+C 中断'));
    expect(frame(ui).match(/用量记录写入失败/g)).toHaveLength(2);
  } finally { mkdir.mockRestore(); run.mockRestore(); }
});

async function persistedSession(root: string, model: ReturnType<typeof scriptedModel>, signal?: AbortSignal, runSlashCommand?: RunSessionOptions['runSlashCommand'], useBuiltinModel = false, resilience: CommandDependencies['resilience'] = { retries: 0 }) {
  const home = path.join(root, 'user');
  const run = vi.spyOn(tui, 'runSession').mockResolvedValue(0);
  try {
    await sessionCommand({ command: 'session', project: root, open: false }, () => {}, { userConfigHome: home, session: { isTTY: true }, env: { CROSSCHECK_REVIEWER: '测试员' }, resilience, modelOptions: useBuiltinModel ? undefined : { factories: { openai: () => model } } }, signal);
    const ui = render(<SessionApp options={{ ...run.mock.calls[0]![0], signal, mouseTracking: undefined, ...(runSlashCommand && { runSlashCommand }) }} />);
    resize(ui, 60);
    await mounted();
    const id = () => /会话 ID：([a-f0-9-]{36})/.exec(frame(ui))?.[1];
    await waitFor(() => Boolean(id()));
    return { ui, id, home, store: new SessionStore(root, home), send: (text: string) => { ui.stdin.write(text); ui.stdin.write(KEYS.enter); }, done: (text: string) => waitFor(() => frame(ui).includes(text) && !frame(ui).includes('Ctrl+C 中断')) };
  } finally { run.mockRestore(); }
}

it('模型配置部分无效时仍脱敏普通命令的输入和输出', async () => {
  const { root, userHome } = await createProject();
  const secret = 'partial-config-fixture';
  await writeFile(path.join(userHome, '.crosscheck', 'config.yaml'), `models: { planner: invalid }\nproviders:\n  mock: { type: invalid, apiKey: '${secret}' }\n`);
  const { store, id, send, done } = await persistedSession(root, scriptedModel([]), undefined, async () => ({ kind: 'log', code: 0, lines: [`普通命令完成 ${secret}`] }));
  send(`/status --project ${secret}`); await done('普通命令完成');
  const entries = (await store.load(id()!))?.entries;
  expect(entries).toMatchObject([{ kind: 'begin', input: '/status --project [REDACTED]' }, { kind: 'end', status: 'success', output: '退出码 0\n普通命令完成 [REDACTED]' }]);
});

it.each([false, true])('配置缺失或无法解析时普通命令可用（无法解析：%s）', async malformed => {
  const { root, userHome } = await createProject();
  const file = path.join(userHome, '.crosscheck', 'config.yaml');
  const secret = 'unparseable-config-fixture';
  if (malformed) await writeFile(file, `providers: [\napiKey: ${secret}\n`);
  else await fs.rm(file);
  const { store, id, send, done } = await persistedSession(root, scriptedModel([]), undefined, async () => ({ kind: 'log', code: 0, lines: [`普通命令完成 ${secret}`] }));
  send(`/status --project ${secret}`); await done('普通命令完成');
  const entries = (await store.load(id()!))?.entries;
  expect(entries?.at(-1)).toMatchObject({ status: 'success' });
  if (malformed) expect(JSON.stringify(entries)).not.toContain(secret);
  else expect(entries?.at(-1)).toMatchObject({ output: `退出码 0\n普通命令完成 ${secret}` });
});

it('损坏配置保留固定配置诊断与退出码，但忽略任意来源的同名诊断和自由文本', async () => {
  const { root, userHome } = await createProject();
  const marker = '无法确认配置密钥';
  const diagnostic = '全局 ~/.crosscheck/config.yaml 格式或配置不合法';
  const fauxDiagnostic = '会话版本冲突，请重新加载';
  const secret = 'fixture-unreadable-secret';
  await writeFile(path.join(userHome, '.crosscheck', 'config.yaml'), `providers: [\napiKey: ${secret}\n`);
  const { store, id, send, done } = await persistedSession(root, scriptedModel([]), undefined, async tokens => {
    if (tokens[1] === 'throw') throw new Error(fauxDiagnostic);
    return { kind: 'log', code: 3, lines: [fauxDiagnostic, secret] };
  });
  send(`聊天 ${secret}`); await done(marker);
  expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ status: 'error', output: `错误：${diagnostic}` });
  send(`/status ${secret}`); await done(secret);
  expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ status: 'error', output: '退出码 3\n[无法确认配置密钥，已省略文本]' });
  send('/status throw'); await done('错误：[无法确认配置密钥，已省略文本]');
  const snapshot = await store.load(id()!);
  expect(JSON.stringify(snapshot)).not.toContain(secret);
  expect(JSON.stringify(snapshot)).not.toContain(fauxDiagnostic);
  await store.append(id()!, snapshot!.revision, { kind: 'begin', operation: 'slash', input: '/外部操作' });
  send('/status'); await done(`会话开始保存失败，未执行操作：${fauxDiagnostic}`);
  const conflicted = await store.load(id()!);
  expect(conflicted?.revision).toBe(snapshot!.revision + 1);
  expect(conflicted?.entries.at(-1)).toMatchObject({ kind: 'begin', input: '/外部操作' });
});

it('损坏配置下真实斜杠命令归档宿主生成的配置诊断', async () => {
  const { root, userHome } = await createProject();
  await writeFile(path.join(userHome, '.crosscheck', 'config.yaml'), 'providers: [');
  const { store, id, send, done } = await persistedSession(root, scriptedModel([]));
  send('/init'); await done('退出码 3');
  expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ status: 'error', output: '退出码 3\n宿主错误：全局 ~/.crosscheck/config.yaml 格式或配置不合法' });
});

it('损坏配置下真实取消仍保留固定中断诊断', async () => {
  const { root, userHome } = await createProject();
  await writeFile(path.join(userHome, '.crosscheck', 'config.yaml'), 'providers: [');
  const entered = deferred<AbortSignal>(), release = deferred<void>();
  const { ui, store, id, send, done } = await persistedSession(root, scriptedModel([]), undefined, async (_tokens, signal) => {
    entered.resolve(signal);
    await release.promise;
    signal.throwIfAborted();
    throw new Error('不应执行');
  });
  send('/status');
  const signal = await entered.promise;
  try {
    ui.stdin.write('\u0003');
    await waitFor(() => signal.aborted);
  } finally { release.resolve(); }
  await done('AI Agent Command Line Client');
  expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ status: 'cancelled', output: '操作已中断' });
});

it('聊天 JSON 中未知鉴权值不会进入模型请求、历史或存档', async () => {
  const { root } = await createProject();
  const credentials = '{"aUtHoRiZaTiOn":"unknown-auth-test-value","nested":[{"COOKIE":["unknown-cookie-test-value"]}],"safe":"无敏感内容"}';
  const model = scriptedModel([{ text: `回答：${credentials}` }, { text: '继续回答' }]);
  const { id, store, send, done } = await persistedSession(root, model);
  send(credentials); await done('回答：');
  send('继续对话'); await done('继续回答');
  const snapshot = await store.load(id()!);
  for (const data of [model.doGenerateCalls[0]?.prompt, model.doGenerateCalls[1]?.prompt, snapshot]) {
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/unknown-auth-test-value|unknown-cookie-test-value/);
    expect(text).toContain('无敏感内容');
    expect(text).toContain('[REDACTED]');
  }
});

it('恢复替换 ID、界面、有效上下文和用量，不重放失败聊天或命令', async () => {
  const { root } = await createProject();
  const model = scriptedModel([{ text: '答复 fixture-key {"password":"输出秘密"}' }, { error: new Error('模拟失败') }, { text: '恢复后回答' }]);
  const { ui, id, home, store, send, done } = await persistedSession(root, model);
  const oldId = id()!;
  send('问题 fixture-key {"password":"输入秘密"} https://example.test/?token=url-secret');
  await done('答复');
  send('失败问题'); await done('模拟失败');
  send('/status'); await done('退出码 0');
  const original = await store.load(oldId);
  expect(original?.revision).toBe(6);
  expect(original?.history).toHaveLength(2);
  for (const secret of ['fixture-key', '输入秘密', '输出秘密', 'url-secret']) expect(JSON.stringify(original)).not.toContain(secret);
  expect(model.doGenerateCalls[0]?.prompt.at(-1)?.content).toEqual([{ type: 'text', text: original!.history[0]!.content }]);
  send('/clear'); await done('调用 0');
  const fresh = id()!;
  expect(fresh).not.toBe(oldId);
  send('/sessions'); await done(oldId);
  send('/resume'); await done('/resume <UUID>');
  expect(id()).toBe(fresh);
  send('/resume invalid'); await done('退出码 2');
  expect(id()).toBe(fresh);
  expect(await store.load(fresh)).toBeNull();
  send(`/resume ${oldId}`); await done('调用 2');
  expect(id()).toBe(oldId);
  expect(frame(ui)).toContain('模拟失败');
  expect(frame(ui)).not.toContain('已清空对话历史');
  expect(model.doGenerateCalls).toHaveLength(2);
  expect(await store.load(oldId)).toEqual(original);
  send('新问题'); await done('恢复后回答');
  const prompt = model.doGenerateCalls[2]!.prompt;
  expect(prompt.slice(1, 3).map(message => message.content)).toEqual(original!.history.map(message => [{ type: 'text', text: message.content }]));
  expect(JSON.stringify(prompt)).not.toMatch(/失败问题|\/status/);
  expect((await readUsage({ project: root, home, sessionId: oldId })).total.calls).toBe(3);
});

it('已知 provider 密钥在 URL 查询重新编码后仍不进入模型或存档', async () => {
  const { root } = await createProject();
  const home = path.join(root, 'user');
  const filename = path.join(home, '.crosscheck', 'config.yaml');
  const config = JSON.parse(await fs.readFile(filename, 'utf8'));
  const secret = 'sample~secret';
  config.providers.mock.apiKey = secret;
  await writeFile(filename, JSON.stringify(config));
  const url = `https://example.test/?label=${secret}`;
  const model = scriptedModel([{ text: url }]);
  const { id, store, send, done } = await persistedSession(root, model);
  send(url); await done('https://example.test/');
  const snapshot = await store.load(id()!);
  const prompt = model.doGenerateCalls[0]!.prompt.at(-1)!.content as Array<{ text: string }>;
  for (const text of [prompt[0]!.text, ...snapshot!.history.map(item => item.content)]) {
    expect(new URL(text).searchParams.get('label')).not.toContain(secret);
  }
});

it('URL 路径中的混合百分号编码不能暴露已知 provider 密钥', async () => {
  const { root } = await createProject();
  const filename = path.join(root, 'user', '.crosscheck', 'config.yaml');
  const config = JSON.parse(await fs.readFile(filename, 'utf8'));
  config.providers.mock.apiKey = 'sample~secret';
  await writeFile(filename, JSON.stringify(config));
  const url = 'https://example.test/%73ample%7Esecret';
  const model = scriptedModel([{ text: url }]);
  const { id, store, send, done } = await persistedSession(root, model);
  send(url); await done('https://example.test/');
  const snapshot = await store.load(id()!);
  const prompt = model.doGenerateCalls[0]!.prompt.at(-1)!.content as Array<{ text: string }>;
  for (const text of [prompt[0]!.text, ...snapshot!.history.map(item => item.content)]) {
    expect(decodeURIComponent(new URL(text).pathname)).not.toContain('sample~secret');
  }
});

it.each(['回复', '错误'])('聊天开始落盘期间轮换密钥，%s仍使用同一次调用的配置快照脱敏', async kind => {
  const { root } = await createProject();
  const filename = path.join(root, 'user', '.crosscheck', 'config.yaml');
  const config = JSON.parse(await fs.readFile(filename, 'utf8'));
  const marker = '配置快照测试';
  const { ui, id, store, send, done } = await persistedSession(root, scriptedModel([]), undefined, undefined, true);
  const begin = SessionStore.prototype.append;
  const append = vi.spyOn(SessionStore.prototype, 'append').mockImplementation(async function (this: SessionStore, ...args: Parameters<SessionStore['append']>) {
    if (args[2].kind === 'begin') {
      config.providers.mock.apiKey = 'rotated-provider-key';
      await writeFile(filename, JSON.stringify(config));
    }
    return begin.apply(this, args);
  });
  const generate = vi.spyOn(globalThis, 'fetch');
  generate.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const key = request.headers.get('authorization')?.replace('Bearer ', '');
    if (kind === '错误') throw new Error(`${marker} ${key}`);
    return Response.json({ id: 'fake', created_at: 1, model: 'p', output: [{ type: 'message', role: 'assistant', id: 'msg', content: [{ type: 'output_text', text: `${marker} ${key}`, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  try {
    send('问题 fixture-key'); await done(marker);
    expect(frame(ui)).not.toMatch(/fixture-key|rotated-provider-key/);
    const snapshot = await store.load(id()!);
    expect(JSON.stringify(snapshot)).not.toMatch(/fixture-key|rotated-provider-key/);
    expect(snapshot?.entries.at(-1)).toMatchObject({ status: kind === '回复' ? 'success' : 'error' });
  } finally { generate.mockRestore(); append.mockRestore(); }
});

it('恢复显示归档输出而非完整模型回复，下一轮仍收到完整模型回复', async () => {
  const { root } = await createProject();
  const model = scriptedModel([{ text: '下一轮答复' }]);
  const { ui, store, send, done } = await persistedSession(root, model);
  const target = '12345678-1234-4123-8123-123456789abc';
  await store.append(target, 0, { kind: 'begin', operation: 'chat', input: '原问题' });
  await store.append(target, 1, { kind: 'end', begin: 1, status: 'success', output: '归档输出', reply: '完整模型历史' });
  send(`/resume ${target}`); await done('原问题');
  expect(frame(ui)).toContain('归档输出');
  expect(frame(ui)).not.toContain('完整模型历史');
  send('下一轮'); await done('下一轮答复');
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain('完整模型历史');
});

it('目标会话目录读取失败时保留当前 ID 和历史', async () => {
  const { root } = await createProject();
  const { ui, id, home, store, send, done } = await persistedSession(root, scriptedModel([{ text: '当前答复' }]));
  const current = id();
  send('当前问题'); await done('当前答复');
  const target = '12345678-1234-4123-8123-123456789abc';
  await store.append(target, 0, { kind: 'begin', operation: 'chat', input: '目标问题' });
  const { directory } = await projectUsageLocation(root, home);
  const blocked = path.join(directory, '..', 'sessions', target);
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).readdir;
  const read = vi.mocked(fs.readdir).mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === blocked) throw Object.assign(new Error('测试拒绝访问'), { code: 'EACCES' });
    return original(...args);
  }) as typeof fs.readdir);
  try {
    send(`/resume ${target}`); await done('无法读取会话目录');
    expect(id()).toBe(current);
    expect(frame(ui)).toContain('当前答复');
    send('/sessions'); await done('启动项目的历史会话');
    expect(frame(ui)).toContain(target);
  } finally { read.mockRestore(); }
});

it.each([['1.json', '无法读取会话修订 1'], ['12345678-1234-4123-8123-123456789abc.tmp', '发现未提交的暂存文件']])('拒绝只有 %s 的零修订会话，不替换 ID 或历史', async (filename, diagnostic) => {
  const { root } = await createProject();
  const model = scriptedModel([{ text: '当前答复' }, { text: '继续答复' }]);
  const { ui, id, home, send, done } = await persistedSession(root, model);
  send('当前问题'); await done('当前答复');
  const current = id();
  const target = '87654321-1234-4123-8123-123456789abc';
  const { directory } = await projectUsageLocation(root, home);
  const targetDir = path.join(directory, '..', 'sessions', target);
  await fs.mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, filename), '{');
  send(`/resume ${target}`); await done(diagnostic);
  expect(frame(ui)).toContain('退出码 3');
  expect(id()).toBe(current);
  expect(frame(ui)).toContain('当前答复');
  send('继续聊天'); await done('继续答复');
  expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain('当前问题');
});

it('加载恢复期间取消不会切换 ID 或上下文', async () => {
  const { root } = await createProject();
  const model = scriptedModel([{ text: '当前历史答复' }, { text: '取消后的答复' }]);
  const { ui, id, store, send, done } = await persistedSession(root, model);
  const target = '12345678-1234-4123-8123-123456789abc';
  await store.append(target, 0, { kind: 'begin', operation: 'chat', input: '目标历史' });
  const current = id();
  send('当前历史问题'); await done('当前历史答复');
  const entered = deferred<void>(), release = deferred<void>();
  const original = SessionStore.prototype.load;
  const load = vi.spyOn(SessionStore.prototype, 'load').mockImplementation(async function (this: SessionStore, value: string) {
    if (value === target) { entered.resolve(); await release.promise; }
    return original.call(this, value);
  });
  try {
    send(`/resume ${target}`); await entered.promise;
    ui.stdin.write('\u0003'); release.resolve();
    await done('操作已中断');
    expect(id()).toBe(current);
    expect(frame(ui)).not.toContain('目标历史');
    send('下一轮'); await done('取消后的答复');
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('当前历史问题');
  } finally { release.resolve(); load.mockRestore(); }
});

it('开始保存遇到版本冲突时不调用模型，重新恢复后可继续', async () => {
  const { root } = await createProject();
  const model = scriptedModel([{ text: '恢复后的答复' }]);
  const { id, store, send, done } = await persistedSession(root, model);
  const current = id()!;
  await store.append(current, 0, { kind: 'begin', operation: 'slash', input: '/外部进程操作' });
  send('不应调用模型'); await done('会话版本冲突');
  expect(model.doGenerateCalls).toHaveLength(0);
  expect((await store.load(current))?.revision).toBe(1);
  send(`/resume ${current}`); await done('操作未完成');
  send('继续聊天'); await done('恢复后的答复');
  expect(model.doGenerateCalls).toHaveLength(1);
  expect((await store.load(current))?.revision).toBe(3);
});

it('结束保存失败仍显示回复但不推进上下文，也不重试模型', async () => {
  const { root } = await createProject();
  const model = scriptedModel([{ text: '已完成但未保存' }, { text: '第二个答复' }]);
  const { ui, id, store, send, done } = await persistedSession(root, model);
  const original = SessionStore.prototype.append;
  const append = vi.spyOn(SessionStore.prototype, 'append').mockImplementation(function (this: SessionStore, ...args: Parameters<SessionStore['append']>) {
    if (args[1] === 1 && args[2].kind === 'end') return Promise.reject(new Error('模拟写入失败'));
    return original.apply(this, args);
  });
  try {
    send('未保存的问题'); await done('会话结果保存失败');
    expect(frame(ui)).toContain('已完成但未保存');
    expect((await store.load(id()!))?.history).toEqual([]);
    send('下一轮'); await done('第二个答复');
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).not.toContain('未保存的问题');
  } finally { append.mockRestore(); }
});

it.each([true, false])('中断与异常同时发生时仅真实取消归档为 cancelled（真实取消：%s）', async cancelled => {
  const { root } = await createProject();
  const entered = deferred<AbortSignal>(), release = deferred<void>();
  const { ui, id, store, send, done } = await persistedSession(root, scriptedModel([]), undefined, async (_tokens, signal) => {
    entered.resolve(signal);
    await release.promise;
    if (cancelled) signal.throwIfAborted();
    throw new Error('独立命令异常');
  });
  send('/status');
  const signal = await entered.promise;
  try {
    ui.stdin.write('\u0003');
    await waitFor(() => signal.aborted);
  } finally { release.resolve(); }
  await done(cancelled ? '操作已中断' : '独立命令异常');
  expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ kind: 'end', status: cancelled ? 'cancelled' : 'error' });
});

it.each([
  { resume: false, secret: 'ROTATED_HISTORY_FIXTURE_918', input: '第一轮问题 ROTATED_HISTORY_FIXTURE_918' },
  { resume: true, secret: 'ROTATED_HISTORY_FIXTURE_918', input: '第一轮问题 ROTATED_HISTORY_FIXTURE_918' },
  { resume: true, secret: 'sëcret。example', input: '检查 https://prefixsëcret。example.invalid/' },
  { resume: true, secret: 'ⓢëcret', input: '检查 https://prefixⓢëcret.invalid/' },
  { resume: true, secret: 'ⓢëcret', input: '[a](https://first.invalid/?mode=one#anchor?x=1)![img](https://xn--prefixscret-5bb.invalid/)' },
  { resume: true, secret: 'quote"fixture', input: JSON.stringify({ note: 'quote"fixture' }) },
])('旧聊天文本成为当前密钥时拒绝发送且保留原历史（$input；恢复：$resume）', async ({ resume, secret, input }) => {
  const { root, userHome } = await createProject();
  const model = scriptedModel([{ text: '第一轮回答' }, { text: '不应调用模型' }]);
  const first = await persistedSession(root, model);
  const oldId = first.id()!;
  first.send(input);
  await first.done('第一轮回答');
  const original = await first.store.load(oldId);
  const config = path.join(userHome, '.crosscheck', 'config.yaml');
  const settings = JSON.parse(await fs.readFile(config, 'utf8'));
  settings.providers.mock.apiKey = secret;
  await writeFile(config, JSON.stringify(settings));

  if (resume) first.ui.unmount();
  const current = resume ? await persistedSession(root, model) : first;
  if (resume) {
    current.send(`/resume ${oldId}`);
    await current.done('第一轮回答');
    expect(current.id()).toBe(oldId);
    expect(await current.store.load(oldId)).toEqual(original);
  }
  current.send('下一轮问题');
  await current.done('聊天历史命中当前配置密钥');
  expect(model.doGenerateCalls).toHaveLength(1);
  const after = await current.store.load(oldId);
  expect(after?.entries.slice(0, 2)).toEqual(original?.entries);
  expect(after?.history).toEqual(original?.history);
  expect(after?.entries.at(-1)).toMatchObject({ status: 'error', output: expect.stringContaining('聊天历史命中当前配置密钥') });
  expect(after?.entries.at(-1)?.kind === 'end' && after.entries.at(-1)).not.toHaveProperty('reply');
  expect((await readUsage({ project: root, home: userHome, sessionId: oldId })).total.calls).toBe(1);
});

it.each([false, true])('聊天取消与请求异常重叠时账本和归档结局一致（真实取消：%s）', async cancelled => {
  const { root } = await createProject();
  const entered = deferred<AbortSignal>(), release = deferred<void>();
  const model = scriptedModel([]);
  vi.spyOn(model, 'doGenerate').mockImplementation(async options => {
    entered.resolve(options.abortSignal!);
    await release.promise;
    if (cancelled) options.abortSignal!.throwIfAborted();
    throw new Error('独立模型异常');
  });
  const { ui, id, home, store, send, done } = await persistedSession(root, model);
  send('并发取消测试');
  const signal = await entered.promise;
  try {
    ui.stdin.write('\u0003');
    await waitFor(() => signal.aborted);
  } finally { release.resolve(); }
  await done(cancelled ? '操作已中断' : '独立模型异常');
  const status = cancelled ? 'cancelled' : 'error';
  expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ status });
  const { directory } = await projectUsageLocation(root, home);
  const [eventFile] = await fs.readdir(directory);
  expect(JSON.parse(await fs.readFile(path.join(directory, eventFile!), 'utf8'))).toMatchObject({ status, sessionId: id() });
});

it('聊天在模型重试退避中取消时归档为中断，此前已失败的请求仍记为错误', async () => {
  const { root } = await createProject();
  const entered = deferred<void>();
  const model = scriptedModel([{ error: new Error('临时模型故障') }, { text: '不应重试' }]);
  const { ui, id, home, store, send, done } = await persistedSession(root, model, undefined, undefined, false, {
    retries: 1,
    sleep: async (_ms, signal) => {
      await new Promise<void>(resolve => {
        signal!.addEventListener('abort', () => resolve(), { once: true });
        entered.resolve();
      });
    },
  });
  send('退避期间取消');
  await entered.promise;
  ui.stdin.write('\u0003');
  await done('AI Agent Command Line Client');
  expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ kind: 'end', status: 'cancelled', output: '操作已中断' });
  expect(model.doGenerateCalls).toHaveLength(1);
  const { directory } = await projectUsageLocation(root, home);
  const [eventFile] = await fs.readdir(directory);
  expect(JSON.parse(await fs.readFile(path.join(directory, eventFile!), 'utf8'))).toMatchObject({ status: 'error', sessionId: id() });
});

it('损坏会话可查询用量但不修改修订，也不能继续聊天', async () => {
  const { root } = await createProject();
  const model = scriptedModel([{ text: '不应执行' }]);
  const { ui, id, home, store, send, done } = await persistedSession(root, model);
  const old = '12345678-1234-4123-8123-123456789abc';
  await store.append(old, 0, { kind: 'begin', operation: 'chat', input: '未完成的问题' });
  const { directory } = await projectUsageLocation(root, home);
  await writeFile(path.join(directory, '..', 'sessions', old, '2.json'), '{');
  send(`/resume ${old}`); await done('无法读取会话修订 2');
  expect(id()).toBe(old);
  send('不应提交'); await done('只读');
  expect(model.doGenerateCalls).toHaveLength(0);
  send('/sessions'); await done(old);
  await createUsageObserver({ project: root, home, sessionId: old, command: 'chat', role: 'planner', pricing: {}, warn: () => {} })({ ref: 'mock:p', status: 'success', purpose: 'request', usage: null });
  send('/usage --session'); await done('调用 1');
  expect(frame(ui)).toContain('退出码 0');
  expect((await store.load(old))?.revision).toBe(1);
  send('/clear');
  await waitFor(() => Boolean(id()) && id() !== old && frame(ui).includes('已清空对话历史') && !frame(ui).includes('Ctrl+C 中断'));
  const fresh = id()!;
  send('/usage --session'); await done('退出码 0');
  expect((await store.load(fresh))?.entries).toMatchObject([{ kind: 'begin', input: '/usage --session' }, { kind: 'end', status: 'success' }]);
  expect(id()).not.toBe(old);
  expect((await store.load(old))?.revision).toBe(1);
});

it.each(['q', '\u0003'])('审核写盘失败后即使页面重读成功，以 %j 退出仍归档为错误', async (key) => {
  const { root, artifacts } = await createProject();
  const { ui, id, store, send, done } = await persistedSession(root, scriptedModel([]));
  const write = ArtifactStore.prototype.writeJson;
  const read = ArtifactStore.prototype.readBytes;
  const rereadStarted = deferred<void>(), releaseReread = deferred<void>();
  let failedWrite = false;
  const injected = vi.spyOn(ArtifactStore.prototype, 'writeJson').mockImplementation(async function (this: ArtifactStore, ...args) {
    if (args[0] === 'approvals.json') {
      failedWrite = true;
      throw new Error('确认记录写盘失败 fixture-key');
    }
    return write.apply(this, args);
  });
  const reread = vi.spyOn(ArtifactStore.prototype, 'readBytes').mockImplementation(async function (this: ArtifactStore, rel) {
    if (failedWrite && rel === 'system/environments.yaml') {
      rereadStarted.resolve();
      await releaseReread.promise;
    }
    return read.call(this, rel);
  });
  try {
    send(`/review profile --project "${root}"`);
    await waitFor(() => frame(ui).includes('environments.yaml'));
    ui.stdin.write('a');
    await rereadStarted.promise;
    // 先观察旧画像行在重读期间消失，再等待新行出现，避免退出键落在未完成的读取上。
    await waitFor(() => frame(ui).includes('加载中') && frame(ui).includes('确认记录写盘失败'));
    expect(frame(ui)).not.toContain('fixture-key');
    releaseReread.resolve();
    await waitFor(() => !frame(ui).includes('加载中') && frame(ui).includes('environments.yaml'));
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
    ui.stdin.write(key);
    await done('审核错误');
    expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ status: 'error', output: '审核错误：确认记录写盘失败 [REDACTED]' });
  } finally { releaseReread.resolve(); injected.mockRestore(); reread.mockRestore(); }
});

it.each([false, true])('审核加载失败后按最终页面状态归档（修复：%s）', async repaired => {
  const { root, artifacts } = await createProject();
  const { ui, id, store, send, done } = await persistedSession(root, scriptedModel([]));
  send(`/review notes --project "${root}"`);
  await waitFor(() => frame(ui).includes('notes.md 不存在'));
  if (repaired) {
    await writeFile(artifacts.resolve('notes.md'), '# 补齐笔记');
    // 撤销动作结束后走正常重读路径，不能把首次加载错误钉死为终态。
    ui.stdin.write('r');
    await waitFor(() => !frame(ui).includes('notes.md 不存在') && frame(ui).includes('notes.md'));
  }
  ui.stdin.write('q');
  await done(repaired ? '审核已结束' : '审核错误');
  expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ kind: 'end', status: repaired ? 'success' : 'error' });
});

it('审核画像单文件校验错误显示后退出时归档为错误', async () => {
  const { root, artifacts } = await createProject();
  await artifacts.writeYaml('system/environments.yaml', { version: 2 });
  const { ui, id, store, send, done } = await persistedSession(root, scriptedModel([]));
  send(`/review profile --project "${root}"`);
  await waitFor(() => frame(ui).includes('不合法'));
  ui.stdin.write('q');
  await done('AI Agent Command Line Client');
  expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ kind: 'end', status: 'error', output: expect.stringContaining('environments.yaml') });
});

it.each([false, true])('审核画像交叉校验错误按同页重读结果归档（重读修复：%s）', async repaired => {
  const { root, artifacts, session } = await createProject();
  await artifacts.writeYaml('system/auth.yaml', { version: 1, actors: { guest: { kind: 'form', environment: 'missing-env', actions: [{ kind: 'goto', url: '/' }] } } });
  const files = await readProfileFiles(artifacts);
  await session.mutate(approvals => {
    for (const file of files) {
      if (!file.present || !file.ok) throw new Error(`测试画像不合法：${file.name}`);
      approvals.approve('profile', file.name, file.value, session.reviewer);
    }
  });
  const { ui, id, store, send } = await persistedSession(root, scriptedModel([]));
  const sessionId = id()!;
  send(`/review profile --project "${root}"`);
  await waitFor(() => frame(ui).includes('交叉校验未通过'));
  if (repaired) {
    await artifacts.writeYaml('system/auth.yaml', { version: 1, actors: { guest: { kind: 'anonymous' } } });
    ui.stdin.write('r');
    await waitFor(() => frame(ui).includes('已撤销') && frame(ui).includes('确认已失效') && frame(ui).includes('未确认') && !frame(ui).includes('交叉校验未通过'));
  }
  ui.stdin.write('q');
  await vi.waitFor(async () => {
    expect((await store.load(sessionId))?.entries.at(-1)).toMatchObject({ kind: 'end' });
  });
  expect((await store.load(sessionId))?.entries.at(-1)).toMatchObject(repaired
    ? { kind: 'end', status: 'success', output: '审核已结束' }
    : { kind: 'end', status: 'error', output: expect.stringContaining('missing-env') });
});

it.each([false, true])('审核离开失败子页后只在重读同页成功时清除错误（重读：%s）', async recover => {
  const { root, artifacts } = await createProject();
  const { ui, id, store, send, done } = await persistedSession(root, scriptedModel([]));
  send(`/review --project "${root}"`);
  await waitFor(() => frame(ui).includes('结果审核（运行 0 次）'));
  const enterNotes = async () => {
    for (let i = 0; i < 4; i++) {
      ui.stdin.write(KEYS.down);
      await waitFor(() => frame(ui).split('\n').some(line => line.includes('›') && line.includes(['条款审核', '用例审核', '结果审核', '项目笔记审核'][i]!)));
    }
    ui.stdin.write(KEYS.enter);
  };
  await enterNotes();
  await waitFor(() => frame(ui).includes('notes.md 不存在'));
  ui.stdin.write(KEYS.escape);
  await waitFor(() => frame(ui).includes('结果审核（运行 0 次）'));
  if (recover) {
    await writeFile(artifacts.resolve('notes.md'), '# 补齐笔记');
    await enterNotes();
    await waitFor(() => frame(ui).includes('notes.md') && !frame(ui).includes('notes.md 不存在'));
  }
  ui.stdin.write('q');
  await done(recover ? '审核已结束' : '审核错误');
  expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ status: recover ? 'success' : 'error' });
});

it('CLI 的真实取消保留日志与退出码二，同时归档为取消', async () => {
  const { root } = await createProject();
  const { ui, id, store, send, done } = await persistedSession(root, scriptedModel([]));
  const entered = deferred<void>(), release = deferred<void>();
  const original = ArtifactStore.prototype.readYaml;
  const read = vi.spyOn(ArtifactStore.prototype, 'readYaml').mockImplementation(async function <T>(this: ArtifactStore, ...args: Parameters<ArtifactStore['readYaml']>) {
    if (args[0] === 'config.yaml') { entered.resolve(); await release.promise; }
    return original.call(this, ...args) as Promise<T | undefined>;
  });
  try {
    send('/init');
    await entered.promise; ui.stdin.write('\u0003'); release.resolve();
    await done('执行被中断');
    expect(frame(ui)).toContain('退出码 2');
    expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ status: 'cancelled', output: expect.stringContaining('已完整写入的文件保留') });
  } finally { release.resolve(); read.mockRestore(); }
});

it('/run 只读门禁失败与外部取消重叠时沿用 runner 的中断分类', async () => {
  const { root } = await createProject();
  const controller = new AbortController();
  const { ui, id, store, send } = await persistedSession(root, scriptedModel([]), controller.signal);
  const sessionId = id()!;
  const entered = deferred<void>(), release = deferred<void>();
  const original = ArtifactStore.prototype.readJson;
  const read = vi.spyOn(ArtifactStore.prototype, 'readJson').mockImplementation(async function <T>(this: ArtifactStore, ...args: Parameters<ArtifactStore['readJson']>) {
    if (args[0] === 'approvals.json') { entered.resolve(); await release.promise; }
    return original.call(this, ...args) as Promise<T | undefined>;
  });
  try {
    send('/run');
    await entered.promise;
    controller.abort();
    release.resolve();
    await waitFor(() => exit.mock.calls.length > 0);
    expect(frame(ui)).toContain('退出码 2');
    expect((await store.load(sessionId))?.entries.at(-1)).toMatchObject({ status: 'cancelled', output: expect.stringMatching(/退出码 2[\s\S]*画像/) });
  } finally { release.resolve(); read.mockRestore(); }
});

it('/run 全局配置解析失败时终端保留诊断、归档省略非结构化输出', async () => {
  const { root, userHome } = await createProject();
  await writeFile(path.join(userHome, '.crosscheck', 'config.yaml'), 'providers: [');
  const { store, id, send, done } = await persistedSession(root, scriptedModel([]));
  const sessionId = id()!;
  send('/run');
  await done('全局 ~/.crosscheck/config.yaml 格式或配置不合法');
  expect((await store.load(sessionId))?.entries.at(-1)).toMatchObject({ status: 'error', output: '退出码 2\n[无法确认配置密钥，已省略文本]' });
});

it('可写会话的 /usage 开始记录写入失败时不会执行账本查询', async () => {
  const { root } = await createProject();
  const { ui, id, home, store, send, done } = await persistedSession(root, scriptedModel([]));
  const sessionId = id()!;
  await createUsageObserver({ project: root, home, sessionId, command: 'chat', role: 'planner', pricing: {}, warn: () => {} })({ ref: 'mock:p', status: 'success', purpose: 'request', usage: null });
  const link = vi.mocked(fs.link).mockRejectedValueOnce(new Error('模拟会话写盘失败'));
  try {
    send('/usage --session');
    await done('会话开始保存失败，未执行操作');
    expect(frame(ui)).not.toContain('按模型分组');
    expect(await store.load(sessionId)).toBeNull();
  } finally { link.mockRestore(); }
  send('/usage --session');
  await done('按模型分组');
  expect(frame(ui)).toContain('调用 1');
});

it('Ctrl+C 后返回的确定命令结果仍按退出码保存', async () => {
  const { root } = await createProject();
  const entered = deferred<void>(), release = deferred<void>();
  const { ui, id, store, send, done } = await persistedSession(root, scriptedModel([]), undefined, async () => {
    entered.resolve(); await release.promise;
    return { kind: 'log', code: 0, lines: ['命令已完成'] };
  });
  try {
    send('/report');
    await entered.promise; ui.stdin.write('\u0003'); release.resolve();
    await done('命令已完成');
    expect((await store.load(id()!))?.entries.at(-1)).toMatchObject({ kind: 'end', status: 'success', output: '退出码 0\n命令已完成' });
    expect(frame(ui)).not.toContain('操作已中断');
  } finally { release.resolve(); }
});

it.each(['q', '\u0003', '外部取消'])('审核返回（%s）保存最终状态，外部退出等待保存', async action => {
  const { root } = await createProject();
  const controller = new AbortController();
  const { ui, id, store, send, done } = await persistedSession(root, scriptedModel([]), controller.signal);
  const oldId = id()!;
  const entered = deferred<void>(), release = deferred<void>();
  const original = SessionStore.prototype.append;
  const append = vi.spyOn(SessionStore.prototype, 'append').mockImplementation(async function (this: SessionStore, ...args: Parameters<SessionStore['append']>) {
    if (args[2].kind === 'end') { entered.resolve(); await release.promise; }
    return original.apply(this, args);
  });
  try {
    send(`/review profile --project "${root}"`);
    await waitFor(() => frame(ui).includes('environments.yaml'));
    expect((await store.load(oldId))?.revision).toBe(1);
    if (action === '外部取消') controller.abort(); else ui.stdin.write(action);
    await entered.promise;
    expect(exit).not.toHaveBeenCalled();
    release.resolve();
    if (action === '外部取消') await waitFor(() => exit.mock.calls.length > 0);
    else await done('AI Agent Command Line Client');
    expect((await store.load(oldId))?.entries.at(-1)).toMatchObject({ kind: 'end', status: action === 'q' ? 'success' : 'cancelled' });
  } finally { release.resolve(); append.mockRestore(); }
});

it.each(['聊天', 'init'] as const)('%s 已确定结果后，账本屏障中的 Ctrl+C 不撤销结果', async kind => {
  const { root, artifacts } = await createProject();
  const home = path.join(root, 'user');
  const { directory } = await projectUsageLocation(root, home);
  const entered = deferred<void>(), release = deferred<void>();
  const originalMkdir = (await vi.importActual<typeof fs>('node:fs/promises')).mkdir;
  const mkdir = vi.mocked(fs.mkdir).mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
    if (args[0] === directory) { entered.resolve(); await release.promise; }
    return originalMkdir(...args);
  }) as typeof fs.mkdir);
  const model = kind === '聊天' ? scriptedModel([{ text: '已生成的答案' }]) : scriptedModel([{ toolCalls: [{ name: 'finish', input: { markdown: '# 已保存的笔记' } }] }]);
  const run = vi.spyOn(tui, 'runSession').mockResolvedValue(0);
  try {
    await sessionCommand({ command: 'session', project: root, open: false }, () => {}, { userConfigHome: home, session: { isTTY: true }, modelOptions: { env: {}, factories: { openai: () => model } } });
    const ui = render(<SessionApp options={{ ...run.mock.calls[0]![0], mouseTracking: undefined }} />);
    resize(ui, 35);
    await mounted();
    ui.stdin.write(kind === '聊天' ? '提问' : '/init'); ui.stdin.write(KEYS.enter);
    await entered.promise;
    if (kind === 'init') expect((await artifacts.readBytes('notes.md'))?.toString()).toBe('# 已保存的笔记');
    const id = /会话 ID：([a-f0-9-]{36})/.exec(frame(ui))?.[1];
    expect(id).toBeDefined();
    const archived = await new SessionStore(root, home).load(id!);
    expect(archived?.entries.at(-1)).toMatchObject({ kind: 'end', status: 'success' });
    ui.stdin.write('\u0003');
    release.resolve();
    await waitFor(() => frame(ui).includes('调用 1') && !frame(ui).includes('Ctrl+C 中断'));
    expect(frame(ui)).not.toContain('操作已中断');
    expect(frame(ui)).toContain(kind === '聊天' ? '已生成的答案' : '退出码 0');
    expect(model.doGenerateCalls).toHaveLength(1);
  } finally { release.resolve(); mkdir.mockRestore(); run.mockRestore(); }
});

it.each([42, 24])('/usage 在 %i 列可读完整 UUID 和每组费用，恶意模型名不折行', async columns => {
  const { root } = await createProject();
  const home = path.join(root, 'user');
  const currentId = '12345678-1234-4123-8123-123456789abc';
  const ref = `mock:${'x'.repeat(160)} 伪造退出码`;
  await createUsageObserver({ project: root, home, sessionId: currentId, command: 'chat', role: 'planner', pricing: { [ref]: { inputPerMTok: 1, outputPerMTok: 2 } }, warn: () => {} })({
    ref, status: 'success', purpose: 'request', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  const ui = render(<SessionApp options={completionOptions({ tokenize: tokenizeCommand, runSlashCommand: createSlashDispatcher({ userConfigHome: home }, { currentId, project: root }) })} />);
  Object.defineProperty(ui.stdout, 'columns', { value: columns, configurable: true });
  resize(ui, 60);
  await mounted();
  ui.stdin.write('/usage --session'); ui.stdin.write(KEYS.enter);
  await waitFor(() => frame(ui).includes('按模型分组'));
  const output = frame(ui);
  const idSection = output.split('会话 ID：')[1]?.split('总计：')[0];
  expect(idSection?.replace(/\s/g, '')).toBe(currentId);
  expect(output).toMatch(/mock:x+…/);
  expect(output).not.toContain('伪造退出码');
  expect(output.replace(/\s/g, '').match(/已知费用估算0\.00012/g)).toHaveLength(4);
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
