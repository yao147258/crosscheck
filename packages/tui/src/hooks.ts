import { setImmediate } from 'node:timers/promises';
import { useApp, useStdin } from 'ink';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Status } from './components';
import { ActionContext, ReviewContext } from './context';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useLoader<T>(load: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; reload(): void } {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [version, setVersion] = useState(0);
  const shared = useContext(ActionContext);
  const signal = useContext(ReviewContext)?.signal;
  useEffect(() => {
    if (signal?.aborted) return;
    let alive = true;
    let failure: unknown;
    shared?.loadStarted?.();
    setState({});
    Promise.resolve().then(() => { signal?.throwIfAborted(); return load(); }).then(
      (data) => { if (alive) setState({ data }); },
      (error) => { failure = error; if (alive) setState({ error: message(error) }); },
    ).finally(() => {
      shared?.loadFinished?.(failure === signal?.reason ? undefined : failure);
    });
    return () => { alive = false; };
  }, [...deps, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { ...state, reload };
}

export function useAction(after?: () => void) {
  const [status, setStatus] = useState<Status>();
  const localBusy = useRef(false);
  const shared = useContext(ActionContext);
  const signal = useContext(ReviewContext)?.signal;
  const busy = shared?.busy ?? localBusy;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const run = useCallback(async (fn: () => Promise<string>): Promise<void> => {
    if (signal?.aborted) return;
    if (busy.current) {
      if (alive.current) setStatus({ kind: 'error', text: '请等待当前操作完成' });
      return;
    }
    busy.current = true;
    shared?.changed();
    setStatus({ kind: 'info', text: '操作进行中，请稍候' });
    let failure: unknown;
    try {
      const text = await fn();
      if (alive.current) setStatus({ kind: 'info', text });
    } catch (error) {
      failure = error;
      if (alive.current) setStatus({ kind: 'error', text: message(error) });
    } finally {
      busy.current = false;
      shared?.changed(failure);
      if (alive.current && !signal?.aborted) after?.();
    }
  }, [after, busy, shared, signal]);
  return { status, setStatus, run };
}

export function useEditorPause() {
  const { suspendTerminal } = useApp();
  const { stdin } = useStdin();
  return useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    let value!: T;
    await suspendTerminal(async () => {
      if (stdin.isTTY && typeof stdin.pause === 'function') {
        // Ink 7.1.1 的重入 readable 栈会再读一次；先退栈再暂停，并等 nextTick 停读后交接。
        await setImmediate();
        stdin.pause();
        await setImmediate();
      }
      value = await fn();
    });
    return value;
  }, [suspendTerminal, stdin]);
}
