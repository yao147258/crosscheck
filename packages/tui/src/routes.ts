import type { Key } from 'ink';

export type Route =
  | { name: 'home' }
  | { name: 'notes' }
  | { name: 'profile' }
  | { name: 'modules'; kind: 'clauses' | 'cases' }
  | { name: 'clauses'; module: string }
  | { name: 'cases'; module: string }
  | { name: 'runs' }
  | { name: 'results'; runId: string };

export type ReviewView = 'notes' | 'profile' | 'clauses' | 'cases' | 'results';
export interface Nav { push(route: Route): void; back(): void; quit(): void }

export function navKey(input: string, key: Key, nav: Nav): boolean {
  if (input === 'q') { nav.quit(); return true; }
  if (key.escape) { nav.back(); return true; }
  return false;
}

export function initialRoute(view?: ReviewView, module?: string, runId?: string): Route {
  switch (view) {
    case 'notes': return { name: 'notes' };
    case 'profile': return { name: 'profile' };
    case 'clauses': return module ? { name: 'clauses', module } : { name: 'modules', kind: 'clauses' };
    case 'cases': return module ? { name: 'cases', module } : { name: 'modules', kind: 'cases' };
    case 'results': return runId ? { name: 'results', runId } : { name: 'runs' };
    default: return { name: 'home' };
  }
}
