import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionContext, ReviewContext, type ReviewEnv } from './context';
import type { Nav, Route } from './routes';
import { CasesView } from './views/cases';
import { ClausesView } from './views/clauses';
import { HomeView } from './views/home';
import { ModulesView } from './views/modules';
import { ProfileView } from './views/profile';
import { ResultsView } from './views/results';
import { RunsView } from './views/runs';

function RouteView({ route, nav }: { route: Route; nav: Nav }) {
  switch (route.name) {
    case 'home': return <HomeView nav={nav} />;
    case 'profile': return <ProfileView nav={nav} />;
    case 'modules': return <ModulesView nav={nav} kind={route.kind} />;
    case 'clauses': return <ClausesView nav={nav} module={route.module} />;
    case 'cases': return <CasesView nav={nav} module={route.module} />;
    case 'runs': return <RunsView nav={nav} />;
    case 'results': return <ResultsView nav={nav} runId={route.runId} />;
  }
}

export function App({ env, initial }: { env: ReviewEnv; initial: Route }) {
  const { exit } = useApp();
  const [stack, setStack] = useState<Route[]>([initial]);
  const [notice, setNotice] = useState<string>();
  const busy = useRef(false);
  const loading = useRef(0);
  const cancelError = useRef<Error | undefined>(undefined);
  const actions = useMemo(() => {
    const changed = (error?: unknown) => {
      setNotice(undefined);
      if (!env.signal?.aborted) return;
      if (error !== undefined && !cancelError.current) {
        cancelError.current = error instanceof Error ? error : new Error(String(error));
      }
      if (!busy.current && loading.current === 0) exit(cancelError.current ?? 2);
    };
    return { busy, changed,
      loadStarted: () => { loading.current++; },
      loadFinished: (error?: unknown) => { loading.current--; changed(error); },
    };
  }, [env.signal, exit]);
  useEffect(() => {
    // 既等待动作写盘，也等待加载器释放运行锁；错误经 Ink 拒绝路径保留给 CLI。
    const interrupt = () => {
      if (busy.current || loading.current > 0) setNotice('执行被中断，等待当前操作完成');
      else actions.changed();
    };
    env.signal?.addEventListener('abort', interrupt, { once: true });
    if (env.signal?.aborted) interrupt();
    return () => env.signal?.removeEventListener('abort', interrupt);
  }, [env.signal, actions]);
  const route = stack[stack.length - 1]!;
  const guard = (fn: () => void) => {
    if (env.signal?.aborted) actions.changed();
    else if (busy.current) setNotice('请等待当前操作完成');
    else fn();
  };
  const nav: Nav = {
    push: (next) => guard(() => setStack((s) => [...s, next])),
    back: () => guard(() => { if (stack.length > 1) setStack((s) => s.slice(0, -1)); else exit(0); }),
    quit: () => guard(() => exit(0)),
  };
  useInput((input, key) => { if (key.ctrl && input === 'c') guard(() => exit(2)); });
  return (
    <ReviewContext.Provider value={env}>
      <ActionContext.Provider value={actions}>
        <Box flexDirection="column">
          <Text bold color="cyan" wrap="truncate-end">Crosscheck 审核 · 确认人 {env.session.reviewer}</Text>
          <RouteView key={`${stack.length}:${JSON.stringify(route)}`} route={route} nav={nav} />
          {notice && <Text color="yellow">{notice}</Text>}
        </Box>
      </ActionContext.Provider>
    </ReviewContext.Provider>
  );
}
