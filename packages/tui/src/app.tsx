import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionContext, ReviewContext, type ReviewEnv } from './context';
import { escapeTerminalLine } from './io/terminal';
import type { Nav, Route } from './routes';
import { CasesView } from './views/cases';
import { ClausesView } from './views/clauses';
import { HomeView } from './views/home';
import { ModulesView } from './views/modules';
import { NotesView } from './views/notes';
import { ProfileView } from './views/profile';
import { ResultsView } from './views/results';
import { RunsView } from './views/runs';

function RouteView({ route, nav }: { route: Route; nav: Nav }) {
  switch (route.name) {
    case 'home': return <HomeView nav={nav} />;
    case 'notes': return <NotesView nav={nav} />;
    case 'profile': return <ProfileView nav={nav} only={route.only} />;
    case 'modules': return <ModulesView nav={nav} kind={route.kind} />;
    case 'clauses': return <ClausesView nav={nav} module={route.module} />;
    case 'cases': return <CasesView nav={nav} module={route.module} />;
    case 'runs': return <RunsView nav={nav} />;
    case 'results': return <ResultsView nav={nav} runId={route.runId} />;
  }
}

export function App({ env, initial, onExitToParent }: { env: ReviewEnv; initial: Route; onExitToParent?: (error?: Error, cancelled?: boolean) => void }) {
  const { exit } = useApp();
  const [stack, setStack] = useState<Route[]>([initial]);
  const [notice, setNotice] = useState<string>();
  const busy = useRef(false);
  const loading = useRef(0);
  const cancelError = useRef<Error | undefined>(undefined);
  const actionError = useRef<Error | undefined>(undefined);
  const pageErrors = useRef(new Map<string, Error>());
  const route = stack[stack.length - 1]!;
  const routeKey = JSON.stringify(route);
  const cancellation = useMemo(() => new AbortController(), []);
  const signal = cancellation.signal;
  const actions = useMemo(() => {
    const changed = (error?: unknown) => {
      setNotice(undefined);
      if (!signal.aborted) return;
      if (error !== undefined && !cancelError.current) {
        cancelError.current = error instanceof Error ? error : new Error(String(error));
      }
      if (!busy.current && loading.current === 0) {
        if (onExitToParent) onExitToParent(actionError.current ?? cancelError.current ?? pageErrors.current.values().next().value, true);
        else exit(cancelError.current ? new Error(env.normalizeError?.(cancelError.current.message) ?? '审核中断时发生错误') : 2);
      }
    };
    return { busy, changed: () => changed(),
      actionFinished: (error?: unknown) => {
        // 动作失败与页面读取失败独立；随后重读成功不能抹掉本次审核中的写盘错误。
        if (onExitToParent && error !== undefined && !actionError.current) {
          actionError.current = error instanceof Error ? error : new Error(String(error));
        }
        changed(error);
      },
      loadStarted: () => { loading.current++; },
      loadFinished: (error?: unknown, active = true) => {
        loading.current--;
        if (active && !signal.aborted) {
          // 其他页面成功加载不能掩盖此前失败的子页。
          if (error === undefined) pageErrors.current.delete(routeKey);
          else pageErrors.current.set(routeKey, error instanceof Error ? error : new Error(String(error)));
        }
        changed(error);
      },
    };
  }, [signal, exit, env.normalizeError, onExitToParent, routeKey]);
  const interrupt = () => {
    cancellation.abort();
    // 既等待动作写盘，也等待加载器释放运行锁；错误经 Ink 拒绝路径保留给 CLI。
    if (busy.current || loading.current > 0) setNotice('执行被中断，等待当前操作完成');
    else actions.changed();
  };
  useEffect(() => {
    env.signal?.addEventListener('abort', interrupt, { once: true });
    if (env.signal?.aborted) interrupt();
    return () => env.signal?.removeEventListener('abort', interrupt);
  }, [env.signal, actions]);
  const guard = (fn: () => void) => {
    if (signal.aborted || env.signal?.aborted) actions.changed();
    else if (busy.current || (onExitToParent && loading.current > 0)) setNotice('请等待当前操作完成');
    else fn();
  };
  const leave = () => { if (onExitToParent) onExitToParent(actionError.current ?? pageErrors.current.values().next().value); else exit(0); };
  const nav: Nav = {
    push: (next) => guard(() => setStack((s) => [...s, next])),
    back: () => guard(() => {
      if (stack.length === 1) { leave(); return; }
      setStack((s) => s.slice(0, -1));
    }),
    quit: () => guard(leave),
  };
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      // 写盘期间维持拒绝提前退出的约定；加载期间则记住取消并等待清理。
      if (busy.current) setNotice('请等待当前操作完成');
      else interrupt();
    }
  });
  return (
    <ReviewContext.Provider value={{ ...env, signal }}>
      <ActionContext.Provider value={actions}>
        <Box flexDirection="column">
          <Text bold color="cyan" wrap="truncate-end">Crosscheck 审核 · 确认人 {escapeTerminalLine(env.session.reviewer)}</Text>
          <RouteView key={`${stack.length}:${JSON.stringify(route)}`} route={route} nav={nav} />
          {notice && <Text color="yellow">{notice}</Text>}
        </Box>
      </ActionContext.Provider>
    </ReviewContext.Provider>
  );
}
