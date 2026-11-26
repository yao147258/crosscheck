import { Box, Text, render, useApp, useBoxMetrics, useCursor, useInput, useWindowSize, type DOMElement } from 'ink';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App } from './app';
import type { ReviewEnv } from './context';
import { formatTime, safeText, SessionHeader, type SessionInfo } from './header';
import { initialRoute, type ReviewView } from './routes';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export type SlashCommandResult =
  | { kind: 'exit' }
  | { kind: 'clear' }
  | { kind: 'review'; args: { project: string; view?: ReviewView; modules?: string[]; runId?: string } }
  | { kind: 'log'; code: number; lines: string[]; truncateLineIndices?: readonly number[] };
export interface SlashCommandMeta { name: string; description: string }
export type SessionProgress = (text: string, kind?: 'warning') => void;
/** 登记业务结果确定后必须等待的收尾；收尾不受本次业务取消控制。 */
export type RegisterSessionSettle = (settle: () => Promise<void>) => void;
export interface RunSessionOptions {
  info?: SessionInfo;
  slashCommands?: SlashCommandMeta[];
  tokenize: (text: string) => string[];
  /** 普通进度仅在执行中展示；warning 同时保留在界面历史，不进入模型上下文。 */
  runSlashCommand: (tokens: string[], signal: AbortSignal, onProgress?: SessionProgress, registerSettle?: RegisterSessionSettle) => Promise<SlashCommandResult>;
  resolveReview: (args: Extract<SlashCommandResult, { kind: 'review' }>['args'], signal: AbortSignal) => Promise<ReviewEnv>;
  chatReply: (history: ChatMessage[], text: string, signal: AbortSignal, onProgress?: SessionProgress, registerSettle?: RegisterSessionSettle) => Promise<string>;
  resetSession: () => void;
  loadSessionUsage: () => Promise<string>;
  /** 开关终端鼠标上报；聊天界面启用以响应滚轮，进入审核界面时关闭。 */
  mouseTracking?: (enabled: boolean) => void;
  signal?: AbortSignal;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// 执行提示只显示最近若干行，避免刷屏。
const ACTIVITY_LINES = 6;
const MODEL_COMMANDS = new Set(['init', 'profile', 'reqs', 'plan', 'run']);
const USAGE_UNAVAILABLE = '会话用量：统计不完整（无法读取）';
// SGR 鼠标上报序列（ink 已去掉开头的 ESC），按钮码 64/65 为滚轮上/下，4/8/16 位为修饰键。
const MOUSE = /^\[<(\d+);\d+;\d+[Mm]$/;
const WHEEL_STEP = 3;
// 滚动条只画滑块不画轨道；两端用半截粗线收窄，呈圆角效果。
const thumbChar = (index: number, length: number) => length === 1 ? '┃' : index === 0 ? '╻' : index === length - 1 ? '╹' : '┃';

export function SessionApp({ options }: { options: RunSessionOptions }) {
  const { exit } = useApp();
  const { rows, columns } = useWindowSize();
  const content = useRef<DOMElement>(null);
  const { height } = useBoxMetrics(content);
  const inputHeight = Math.min(3, Math.max(1, rows));
  const launchedAt = useMemo(() => formatTime(new Date()), []);
  const [messages, setMessages] = useState<Array<ChatMessage & { reportLines?: Array<{ text: string; truncate: boolean }> }>>([]);
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
  const [sessionUsage, setSessionUsage] = useState<string>();
  const operation = useRef<AbortController | undefined>(undefined);
  const usageRevision = useRef(0);
  const refreshUsage = useCallback(async () => {
    const revision = ++usageRevision.current;
    let usage: string;
    try { usage = await options.loadSessionUsage(); }
    catch { usage = USAGE_UNAVAILABLE; }
    if (revision === usageRevision.current) setSessionUsage(usage);
  }, [options.loadSessionUsage]);
  useEffect(() => {
    void refreshUsage();
    return () => { usageRevision.current++; };
  }, [refreshUsage]);
  const [review, setReview] = useState<{ env: ReviewEnv; args: Extract<SlashCommandResult, { kind: 'review' }>['args'] }>();
  const reviewActive = useRef(false);
  const externalAbort = useRef(false);
  // 提示列表占据输入框下方的行数，相应压缩消息视口。
  const hintItems = busy ? [] : matchCommands(input);
  const hintHeight = hintItems.length;
  const viewport = Math.min(height || Math.max(0, rows - inputHeight - hintHeight), Math.max(0, rows - inputHeight - hintHeight));
  // 输入框与提示区不写终端最后一列：Windows 控制台写满末行最后一列会立即换行并整屏上滚，导致光标错位。
  // 消息视口不含末行，可占满整宽，滚动条贴最右列。
  const width = Math.max(1, columns - 1);
  const fullWidth = Math.max(1, columns);
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
    const warnings = new Set<string>();
    const progress: SessionProgress = (line, kind) => {
      if (operation.current !== controller) return;
      if (kind === 'warning') warnings.add(line);
      const lines = line.split('\n').filter((item) => item.trim());
      if (lines.length) setActivity((items) => [...items, ...lines].slice(-ACTIVITY_LINES));
    };
    const settleTasks: Array<() => Promise<void>> = [];
    const registerSettle: RegisterSessionSettle = settle => { settleTasks.push(settle); };
    let failure: Error | undefined;
    let refresh = !text.startsWith('/');
    try {
      if (text.startsWith('/')) {
        const tokens = options.tokenize(text.slice(1));
        refresh = MODEL_COMMANDS.has(tokens[0] ?? '');
        const result = await options.runSlashCommand(tokens, controller.signal, progress, registerSettle);
        controller.signal.throwIfAborted();
        if (result.kind === 'exit') { exit(0); return; }
        if (result.kind === 'clear') {
          options.resetSession();
          refresh = true;
          setMessages([{ role: 'assistant', content: '已清空对话历史' }]);
          history.current = [];
          return;
        }
        if (result.kind === 'log') {
          const lines = [`退出码 ${result.code}`, ...result.lines];
          if (result.truncateLineIndices) {
            const truncate = new Set(result.truncateLineIndices);
            const reportLines = lines.map((text, index) => ({ text, truncate: truncate.has(index - 1) }));
            setMessages(items => [...items, { role: 'assistant', content: '', reportLines }]);
          } else append('assistant', lines.join('\n'));
        }
        if (result.kind === 'review') {
          const env = await options.resolveReview(result.args, controller.signal);
          controller.signal.throwIfAborted();
          reviewActive.current = true;
          setReview({ env: { ...env, signal: controller.signal }, args: result.args });
          return;
        }
      } else {
        const reply = await options.chatReply(history.current, text, controller.signal, progress, registerSettle);
        controller.signal.throwIfAborted();
        history.current = [...history.current, { role: 'user' as const, content: text }, { role: 'assistant' as const, content: reply }].slice(-20);
        append('assistant', reply);
      }
    } catch (error) {
      const cancelled = controller.signal.aborted && (error === controller.signal.reason || (error instanceof Error && error.name === 'AbortError'));
      if (!cancelled) failure = error instanceof Error ? error : new Error(String(error));
      append('assistant', controller.signal.aborted ? `操作已中断${failure ? `：${failure.message}` : ''}` : `错误：${failure?.message}`);
    } finally {
      try {
        for (const settle of settleTasks) await settle();
        if (refresh) await refreshUsage();
      } catch {
        setSessionUsage(USAGE_UNAVAILABLE);
        warnings.add('用量收尾失败，本次统计不完整');
      }
      for (const warning of warnings) append('assistant', warning);
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
    // Ink 仅在末行有内容、输出不以换行结尾时需要补偿一行。
    const cursorOffset = viewport + inputHeight + hintHeight >= rows ? 1 : 0;
    const y = viewport + (inputHeight >= 3 ? 1 : 0) + cursorOffset;
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
  return <Box flexDirection="column" height={Math.max(1, rows)} width={fullWidth}>
    <Box height={viewport} overflow="hidden" flexShrink={0}>
      <Box ref={content} position="absolute" top={-(maxScroll - offset)} width={Math.max(1, fullWidth - 2)} flexDirection="column">
        <SessionHeader info={options.info} width={Math.max(1, fullWidth - 2)} busy={busy} launchedAt={launchedAt} usage={sessionUsage} />
        {messages.map((m, i) => m.role === 'user'
          ? <Box key={i} backgroundColor="#b8b8b8"><Text color="black">{safeText(m.content)}</Text></Box>
          : m.reportLines ? <Box key={i} flexDirection="column">
            {m.reportLines.map(({ text, truncate }, index) => <Text key={index} wrap={truncate ? 'truncate-end' : 'wrap'}>{safeText(text).replace(/\n/g, '\\n')}</Text>)}
          </Box> : <Text key={i}>{safeText(m.content)}</Text>)}
        {busy && activity.map((line, i) => <Text key={`activity-${i}`} color="gray" wrap="truncate-end">  {safeText(line)}</Text>)}
      </Box>
      {thumb > 0 && <Box position="absolute" left={fullWidth - 1} top={thumbStart} flexDirection="column">
        {Array.from({ length: thumb }, (_, i) => <Text key={i} color="gray">{thumbChar(i, thumb)}</Text>)}
      </Box>}
    </Box>
    <Box width={width} borderStyle="single" borderColor="white" borderLeft={false} borderRight={false} borderTop={inputHeight >= 3} borderBottom={inputHeight >= 2} flexShrink={0}><Text wrap="truncate-start">{busy ? `${SPINNER[tick % SPINNER.length]} 执行中 ${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s，Ctrl+C 中断并等待清理` : `> ${safeText(input)}`}</Text></Box>
    {hintHeight > 0 && <Box width={width} flexDirection="column" flexShrink={0}>
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
