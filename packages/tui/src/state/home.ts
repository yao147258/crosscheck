import type { ReviewSession } from '../io/session';
import { loadCaseOverview } from './cases';
import { loadClauseRows } from './clauses';
import { loadProfileOverview } from './profile';
import { listRuns } from './results';

export interface HomeSummary { profilePending: number; clausesPending: number; casesPending: number; runs: number }

export async function loadHomeSummary(session: ReviewSession): Promise<HomeSummary> {
  const profilePending = (await loadProfileOverview(session)).rows.filter((r) => r.status !== 'approved').length;
  let clausesPending = 0;
  for (const module of await session.artifacts.listModules('requirements')) {
    clausesPending += (await loadClauseRows(session, module)).filter((r) => r.clause.status === 'active' && r.approval !== 'approved').length;
  }
  let casesPending = 0;
  for (const module of await session.artifacts.listModules('cases')) {
    casesPending += (await loadCaseOverview(session, module)).rows.filter((r) => r.approval !== 'approved').length;
  }
  return { profilePending, clausesPending, casesPending, runs: (await listRuns(session)).length };
}
