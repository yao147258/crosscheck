import { useApp } from 'ink';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Status } from './components';
import { ActionContext, ReviewContext } from './context';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useLoader<T>(load: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; reload(): void } {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({});
    Promise.resolve().then(load).then(
      (data) => { if (alive) setState({ data }); },
      (error) => { if (alive) setState({ error: message(error) }); },
    );
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
    try {
      const text = await fn();
      if (alive.current) setStatus({ kind: 'info', text });
    } catch (error) {
      if (alive.current) setStatus({ kind: 'error', text: message(error) });
    } finally {
      busy.current = false;
      shared?.changed();
      if (alive.current) after?.();
    }
  }, [after, busy, shared, signal]);
  return { status, setStatus, run };
}

export function useEditorPause() {
  const { suspendTerminal } = useApp();
  return useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    let value!: T;
    await suspendTerminal(async () => { value = await fn(); });
    return value;
  }, [suspendTerminal]);
}
