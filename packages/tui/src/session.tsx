import { Box, Text, render, useApp, useBoxMetrics, useCursor, useInput, useWindowSize, type DOMElement } from 'ink';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { App } from './app';
import type { ReviewEnv } from './context';
import { initialRoute, type ReviewView } from './routes';

const safeText = (text: string) => text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');

const banner = String.raw`  ____ ____   ___  ____ ____   ____ _   _ _____ ____ _  __
 / ___|  _ \ / _ \/ ___/ ___| / ___| | | | ____/ ___| |/ /
| |   | |_) | | | \___ \___ \| |   | |_| |  _|| |   | ' /
| |___|  _ <| |_| |___) |__) | |___|  _  | |__| |___| . \
 \____|_| \_\\___/|____/____/ \____|_| |_|_____\____|_|\_\ `;

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export type SlashCommandResult =
  | { kind: 'exit' }
  | { kind: 'clear' }
  | { kind: 'review'; args: { project: string; view?: ReviewView; modules?: string[]; runId?: string } }
  | { kind: 'log'; code: number; lines: string[] };
export interface SlashCommandMeta { name: string; description: string }
export interface RunSessionOptions {
  info?: { version: string; models: { extractor: string; planner: string; executor: string; reviewer: string } | undefined };
  slashCommands?: SlashCommandMeta[];
  tokenize: (text: string) => string[];
  /** onProgress 接收执行过程中的实时提示（模型请求、工具调用、命令日志），执行期间显示在会话底部。 */
  runSlashCommand: (tokens: string[], signal: AbortSignal, onProgress?: (text: string) => void) => Promise<SlashCommandResult>;
  resolveReview: (args: Extract<SlashCommandResult, { kind: 'review' }>['args'], signal: AbortSignal) => Promise<ReviewEnv>;
  chatReply: (history: ChatMessage[], text: string, signal: AbortSignal, onProgress?: (text: string) => void) => Promise<string>;
  /** 开关终端鼠标上报；聊天界面启用以响应滚轮，进入审核界面时关闭。 */
  mouseTracking?: (enabled: boolean) => void;
  signal?: AbortSignal;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// 执行提示只显示最近若干行，避免刷屏。
const ACTIVITY_LINES = 6;
// SGR 鼠标上报序列（ink 已去掉开头的 ESC），按钮码 64/65 为滚轮上/下，4/8/16 位为修饰键。
const MOUSE = /^\[<(\d+);\d+;\d+[Mm]$/;
const WHEEL_STEP = 3;

export function SessionApp({ options }: { options: RunSessionOptions }) {
  const { exit } = useApp();
  const { rows, columns } = useWindowSize();
  const content = useRef<DOMElement>(null);
  const { height } = useBoxMetrics(content);
  const inputHeight = Math.min(3, Math.max(1, rows));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const history = useRef<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const inputRef = useRef('');
  const updateInput = (value: string) => { inputRef.current = value; setInput(value); };
  // 候选高亮：↑/↓ 在候选列表内移动高亮，Tab 用高亮项补全；编辑输入时重置为第一项。
  const [hintIndex, setHintIndex] = useState(0);
  const hintIndexRef = useRef(0);
  const updateHintIndex = (value: number) => { hintIndexRef.current = value; setHintIndex(value); };
  const matchCommands = (text: string) => {
    if (!text.startsWith('/')) return [];
    const prefix = text.slice(1);
    return (options.slashCommands ?? []).filter((command) => command.name.startsWith(prefix));
  };
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController | undefined>(undefined);
  const [review, setReview] = useState<{ env: ReviewEnv; args: Extract<SlashCommandResult, { kind: 'review' }>['args'] }>();
  const reviewActive = useRef(false);
  const externalAbort = useRef(false);
  // 提示列表占据输入框下方的行数，相应压缩消息视口。
  const hintItems = busy ? [] : matchCommands(input);
  const hintHeight = hintItems.length;
  const viewport = Math.min(height || Math.max(0, rows - inputHeight - hintHeight), Math.max(0, rows - inputHeight - hintHeight));
  // 不写终端最后一列：Windows 控制台写满末行最后一列会立即换行并整屏上滚，导致光标错位。
  const width = Math.max(1, columns - 1);
  // 向上翻看的行数，0 表示贴底跟随最新内容。
  const [scrollUp, setScrollUp] = useState(0);
  const maxScroll = Math.max(0, height - viewport);
  const offset = Math.min(scrollUp, maxScroll);
  const scrollBy = (delta: number) => setScrollUp((value) => Math.max(0, Math.min(maxScroll, Math.min(value, maxScroll) + delta)));
  // 执行中的实时提示与计时；tick 驱动转圈动画与耗时刷新。
  const [activity, setActivity] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setTick((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (review) return;
    options.mouseTracking?.(true);
    return () => options.mouseTracking?.(false);
  }, [review, options.mouseTracking]);
  const append = (role: ChatMessage['role'], content: string) => setMessages((items) => [...items, { role, content }]);
  const cancel = useCallback(() => {
    externalAbort.current = true;
    operation.current?.abort();
    if (!operation.current && !reviewActive.current) exit(2);
  }, [exit]);
  useEffect(() => {
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    return () => options.signal?.removeEventListener('abort', cancel);
  }, [options.signal, cancel]);
  const submit = async (text: string) => {
    if (operation.current || reviewActive.current || externalAbort.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setScrollUp(0);
    setActivity([]);
    setStartedAt(Date.now());
    append('user', text);
    // 只接收本次操作的提示，操作结束后迟到的提示直接丢弃。
    const progress = (line: string) => {
      if (operation.current !== controller) return;
      const lines = line.split('\n').filter((item) => item.trim());
      if (lines.length) setActivity((items) => [...items, ...lines].slice(-ACTIVITY_LINES));
    };
    let failure: Error | undefined;
    try {
      if (text.startsWith('/')) {
        const result = await options.runSlashCommand(options.tokenize(text.slice(1)), controller.signal, progress);
        controller.signal.throwIfAborted();
        if (result.kind === 'exit') { exit(0); return; }
        if (result.kind === 'clear') {
          setMessages([{ role: 'assistant', content: '已清空对话历史' }]);
          history.current = [];
          return;
        }
        if (result.kind === 'log') append('assistant', `退出码 ${result.code}\n${result.lines.join('\n')}`);
        if (result.kind === 'review') {
          const env = await options.resolveReview(result.args, controller.signal);
          controller.signal.throwIfAborted();
          reviewActive.current = true;
          setReview({ env: { ...env, signal: controller.signal }, args: result.args });
          return;
        }
      } else {
        const reply = await options.chatReply(history.current, text, controller.signal, progress);
        controller.signal.throwIfAborted();
        history.current = [...history.current, { role: 'user' as const, content: text }, { role: 'assistant' as const, content: reply }].slice(-20);
        append('assistant', reply);
      }
    } catch (error) {
      const cancelled = controller.signal.aborted && (error === controller.signal.reason || (error instanceof Error && error.name === 'AbortError'));
      if (!cancelled) failure = error instanceof Error ? error : new Error(String(error));
      append('assistant', controller.signal.aborted ? `操作已中断${failure ? `：${failure.message}` : ''}` : `错误：${failure?.message}`);
    } finally {
      if (!reviewActive.current) operation.current = undefined;
      setBusy(false);
      setActivity([]);
      if (externalAbort.current && !reviewActive.current) exit(failure ?? 2);
    }
  };
  // 把终端真实光标定位进输入框：空闲时显示在输入文本末尾，busy 或进入审核时隐藏。
  // useCursor 要求在渲染期间调用（经 useInsertionEffect 在 commit 阶段传播）。
  const cursor = useCursor();
  if (busy || review || reviewActive.current) cursor.setCursorPosition(undefined);
  else {
    // 显示宽度：CJK 等全角字符按 2 列计，近似值足够光标定位。
    const text = safeText(input);
    const textWidth = [...text].reduce((sum, ch) => sum + ((ch.codePointAt(0) ?? 0) > 0xFF ? 2 : 1), 0);
    const x = Math.min(2 + textWidth, Math.max(0, width - 1));
    // 输入文本行自输出顶部的行号 = 消息视口高度 + 顶边框。
    const y = viewport + (inputHeight >= 3 ? 1 : 0);
    cursor.setCursorPosition({ x, y });
  }
  useInput((value, key) => {
    if (reviewActive.current) return;
    // 鼠标事件一律不进入输入框；滚轮按固定行数翻看。
    const mouse = MOUSE.exec(value);
    if (mouse) {
      const button = Number(mouse[1]) & ~0x1c;
      if (button === 64 || button === 65) scrollBy(button === 64 ? WHEEL_STEP : -WHEEL_STEP);
      return;
    }
    if (key.ctrl && value === 'c') {
      if (operation.current) operation.current.abort();
      else append('assistant', '使用 /exit 退出会话');
      return;
    }
    const idle = !busy && !operation.current;
    // 翻页在执行中同样可用；↑/↓ 在没有命令候选时逐行滚动。
    if (key.pageUp || key.pageDown) {
      const page = Math.max(1, viewport);
      scrollBy(key.pageUp ? page : -page);
      return;
    }
    if ((key.upArrow || key.downArrow) && !(idle && matchCommands(inputRef.current).length)) {
      scrollBy(key.upArrow ? 1 : -1);
      return;
    }
    if (!idle) return;
    if (key.return) {
      const text = inputRef.current.trim();
      updateHintIndex(0);
      updateInput('');
      if (text) void submit(text);
    } else if (key.upArrow || key.downArrow) {
      const matches = matchCommands(inputRef.current);
      updateHintIndex((hintIndexRef.current + (key.upArrow ? -1 : 1) + matches.length) % matches.length);
    } else if (key.tab) {
      const matches = matchCommands(inputRef.current);
      if (!matches.length) return;
      updateInput(`/${matches[hintIndexRef.current % matches.length]!.name}`);
      updateHintIndex(0);
    } else if (key.backspace || key.delete) {
      updateHintIndex(0);
      updateInput(inputRef.current.slice(0, -1));
    } else if (!key.ctrl && !key.meta && value) {
      updateHintIndex(0);
      updateInput(inputRef.current + value);
    }
  });
  if (review) return <App env={review.env} initial={initialRoute(review.args.view, review.args.modules?.[0], review.args.runId)} onExitToParent={(error) => {
    reviewActive.current = false;
    operation.current = undefined;
    setReview(undefined);
    if (error) append('assistant', `审核错误：${error.message}`);
    if (externalAbort.current) exit(error ?? 2);
  }} />;
  // 滚动条：按可视比例计算滑块长度，按已翻看位置计算滑块起点。
  const thumb = maxScroll > 0 ? Math.max(1, Math.round(viewport * viewport / height)) : 0;
  const thumbStart = maxScroll > 0 ? Math.round((maxScroll - offset) / maxScroll * (viewport - thumb)) : 0;
  return <Box flexDirection="column" height={Math.max(1, rows)} width={width}>
    <Box height={viewport} overflow="hidden" flexShrink={0}>
      <Box ref={content} position="absolute" top={-(maxScroll - offset)} width={Math.max(1, width - 1)} flexDirection="column">
        {columns >= 59 && <Text color="cyan">{banner}</Text>}
        <Text bold>Crosscheck 交互会话{options.info ? ` · v${safeText(options.info.version)}` : ''}</Text>
        {options.info && (['extractor', 'planner', 'executor', 'reviewer'] as const).map(role => <Text key={role}>{role}：{safeText(options.info?.models?.[role] ?? '未配置')}</Text>)}
        {messages.map((m, i) => m.role === 'user'
          ? <Box key={i} backgroundColor="#b8b8b8"><Text color="black">{safeText(m.content)}</Text></Box>
          : <Text key={i}>{safeText(m.content)}</Text>)}
        {busy && activity.map((line, i) => <Text key={`activity-${i}`} color="gray" wrap="truncate-end">  {safeText(line)}</Text>)}
      </Box>
      {thumb > 0 && <Box position="absolute" left={width - 1} flexDirection="column">
        {Array.from({ length: viewport }, (_, i) => <Text key={i} color="gray">{i >= thumbStart && i < thumbStart + thumb ? '█' : '│'}</Text>)}
      </Box>}
    </Box>
    <Box borderStyle="single" borderColor="white" borderLeft={false} borderRight={false} borderTop={inputHeight >= 3} borderBottom={inputHeight >= 2} flexShrink={0}><Text wrap="truncate-start">{busy ? `${SPINNER[tick % SPINNER.length]} 执行中 ${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s，Ctrl+C 中断并等待清理` : `> ${safeText(input)}`}</Text></Box>
    {hintHeight > 0 && <Box flexDirection="column" flexShrink={0}>
      {hintItems.map((item, i) => <Text key={item.name} bold={i === hintIndex} color={i === hintIndex ? 'white' : 'gray'}>/{item.name} {item.description}</Text>)}
    </Box>}
  </Box>;
}

export async function runSession(options: RunSessionOptions): Promise<number> {
  if (options.signal?.aborted) return 2;
  const instance = render(createElement(SessionApp, { options }), { exitOnCtrlC: false });
  try { return await instance.waitUntilExit() === 2 ? 2 : 0; }
  finally { instance.cleanup(); }
}
