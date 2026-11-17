import { Box, Text, render, useApp, useInput } from 'ink';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { App } from './app';
import type { ReviewEnv } from './context';
import { initialRoute, type ReviewView } from './routes';

const safeText = (text: string) => text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export type SlashCommandResult =
  | { kind: 'exit' }
  | { kind: 'review'; args: { project: string; view?: ReviewView; modules?: string[]; runId?: string } }
  | { kind: 'log'; code: number; lines: string[] };
export interface RunSessionOptions {
  tokenize: (text: string) => string[];
  runSlashCommand: (tokens: string[], signal: AbortSignal) => Promise<SlashCommandResult>;
  resolveReview: (args: Extract<SlashCommandResult, { kind: 'review' }>['args'], signal: AbortSignal) => Promise<ReviewEnv>;
  chatReply: (history: ChatMessage[], text: string, signal: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}

export function SessionApp({ options }: { options: RunSessionOptions }) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const history = useRef<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const inputRef = useRef('');
  const updateInput = (value: string) => { inputRef.current = value; setInput(value); };
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController | undefined>(undefined);
  const [review, setReview] = useState<{ env: ReviewEnv; args: Extract<SlashCommandResult, { kind: 'review' }>['args'] }>();
  const reviewActive = useRef(false);
  const externalAbort = useRef(false);
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
    append('user', text);
    let failure: Error | undefined;
    try {
      if (text.startsWith('/')) {
        const result = await options.runSlashCommand(options.tokenize(text.slice(1)), controller.signal);
        controller.signal.throwIfAborted();
        if (result.kind === 'exit') { exit(0); return; }
        if (result.kind === 'log') append('assistant', `退出码 ${result.code}\n${result.lines.join('\n')}`);
        if (result.kind === 'review') {
          const env = await options.resolveReview(result.args, controller.signal);
          controller.signal.throwIfAborted();
          reviewActive.current = true;
          setReview({ env: { ...env, signal: controller.signal }, args: result.args });
          return;
        }
      } else {
        const reply = await options.chatReply(history.current, text, controller.signal);
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
      if (externalAbort.current && !reviewActive.current) exit(failure ?? 2);
    }
  };
  useInput((value, key) => {
    if (reviewActive.current) return;
    if (key.ctrl && value === 'c') {
      if (operation.current) operation.current.abort();
      else append('assistant', '使用 /exit 退出会话');
      return;
    }
    if (busy || operation.current) return;
    if (key.return) {
      const text = inputRef.current.trim();
      updateInput('');
      if (text) void submit(text);
    } else if (key.backspace || key.delete) updateInput(inputRef.current.slice(0, -1));
    else if (!key.ctrl && !key.meta && value) updateInput(inputRef.current + value);
  });
  if (review) return <App env={review.env} initial={initialRoute(review.args.view, review.args.modules?.[0], review.args.runId)} onExitToParent={(error) => {
    reviewActive.current = false;
    operation.current = undefined;
    setReview(undefined);
    if (error) append('assistant', `审核错误：${error.message}`);
    if (externalAbort.current) exit(error ?? 2);
  }} />;
  return <Box flexDirection="column"><Text bold>Crosscheck 交互会话</Text>{messages.map((m, i) => <Text key={i}>{m.role === 'user' ? '你' : '助手'}：{safeText(m.content)}</Text>)}<Text>{busy ? '执行中，Ctrl+C 中断并等待清理' : `> ${safeText(input)}`}</Text></Box>;
}

export async function runSession(options: RunSessionOptions): Promise<number> {
  if (options.signal?.aborted) return 2;
  const instance = render(createElement(SessionApp, { options }), { exitOnCtrlC: false });
  try { return await instance.waitUntilExit() === 2 ? 2 : 0; }
  finally { instance.cleanup(); }
}
