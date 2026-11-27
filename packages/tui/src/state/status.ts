import { DispositionsFileSchema, type ExpectationStatus, type ProfileFile, type RunManifest } from '@crosscheck/core';
import { loadReportData } from '@crosscheck/report';
import { RunStore } from '@crosscheck/runner';
import type { ReadonlyReviewContext } from '../io/session';
import { loadCaseOverview } from './cases';
import { loadClauseRows } from './clauses';
import { loadProfileOverview } from './profile';
import { listRuns } from './results';

export interface StatusIssue { state: 'missing' | 'incomplete' | 'corrupt'; location: string; message: string }
export interface StatusCount { total: number | null; pending: number | null; issues: StatusIssue[] }
export type StatusStage = 'profile' | 'clauses' | 'cases' | 'run' | 'results';
export type LatestRunStatus =
  | { state: 'missing'; runId?: string; start?: string; status?: RunManifest['status']; error?: string }
  | { state: 'incomplete'; runId: string; start: string; status: RunManifest['status']; error: string }
  | { state: 'corrupt'; runId: string; start?: string; status?: RunManifest['status']; error: string }
  | { state: 'ready'; runId: string; start: string; status: RunManifest['status']; resultStatus: ExpectationStatus; counts: Record<ExpectationStatus, number>; pendingDispositions: number };
export interface ProjectStatus {
  stage: StatusStage;
  profile: StatusCount;
  approvedProfiles: { name: ProfileFile; by: string }[];
  clauses: StatusCount;
  cases: StatusCount;
  latestRun: LatestRunStatus;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function loadCounts(session: ReadonlyReviewContext, kind: 'clauses' | 'cases'): Promise<StatusCount> {
  const directory = kind === 'clauses' ? 'requirements' : 'cases';
  const issues: StatusIssue[] = [];
  let total = 0;
  let pending = 0;
  try {
    const modules = await session.artifacts.listModules(directory);
    for (const module of modules) {
      try {
        if (kind === 'clauses') {
          const rows = await loadClauseRows(session, module);
          const active = rows.filter((row) => row.clause.status === 'active');
          total += active.length;
          pending += active.filter((row) => row.approval !== 'approved').length;
          if (rows.some((row) => row.clause.status === 'unclear')) issues.push({ state: 'incomplete', location: `${directory}/${module}.yaml`, message: '存在不明确的条款' });
        } else {
          const rows = (await loadCaseOverview(session, module)).rows;
          total += rows.length;
          pending += rows.filter((row) => row.approval !== 'approved').length;
        }
      } catch (error) { issues.push({ state: 'corrupt', location: `${directory}/${module}.yaml`, message: message(error) }); }
    }
    if (!total && !issues.length) issues.push({ state: 'missing', location: directory, message: '没有可审核的内容' });
  } catch (error) { issues.push({ state: 'corrupt', location: directory, message: message(error) }); }
  const unknown = issues.some((issue) => issue.state === 'corrupt');
  return { total: unknown ? null : total, pending: unknown ? null : pending, issues };
}

async function loadLatestRun(session: ReadonlyReviewContext): Promise<LatestRunStatus> {
  let runId: string | undefined;
  let manifest: RunManifest | undefined;
  try {
    runId = (await listRuns(session))[0];
    if (!runId) return { state: 'missing' };
    if (!await session.artifacts.readBytes(`runs/${runId}/manifest.json`)) return { state: 'missing', runId, error: '运行清单缺失' };
    const run = await RunStore.load(session.artifacts, runId);
    manifest = run.manifest;
    if (manifest.status !== 'completed') return { state: 'incomplete', runId, start: manifest.start, status: manifest.status, error: '运行尚未完成' };
    if (!await session.artifacts.readBytes(`runs/${runId}/results.json`)) return { state: 'missing', runId, start: manifest.start, status: manifest.status, error: '运行汇总缺失' };
    // 不获取运行锁：锁本身会写盘。并发修改时校验失败即报告，不能伪造一致快照。
    const data = await loadReportData(session.artifacts, run);
    const dispositions = await session.artifacts.readJson(`runs/${runId}/dispositions.json`, DispositionsFileSchema);
    if (dispositions && dispositions.runId !== runId) throw new Error('裁决文件运行归属不一致');
    const counts: Record<ExpectationStatus, number> = { PASS: 0, FAIL: 0, DISPUTED: 0, UNCLEAR: 0, BLOCKED: 0 };
    let pendingDispositions = 0;
    for (const item of data.result.cases) {
      counts[item.status]++;
      for (const expectation of item.expectations) {
        if ((expectation.status === 'FAIL' || expectation.status === 'DISPUTED') && !dispositions?.items.some((d) => d.caseId === item.caseId && d.expectationId === expectation.expectationId)) pendingDispositions++;
      }
    }
    return { state: 'ready', runId, start: manifest.start, status: manifest.status, resultStatus: data.result.status, counts, pendingDispositions };
  } catch (error) { return { state: 'corrupt', runId: runId ?? '', start: manifest?.start, status: manifest?.status, error: message(error) }; }
}

/** 仅读取现有工件；统计不可用时使用 null，避免把损坏数据解释为零。 */
export async function loadStatus(session: ReadonlyReviewContext): Promise<ProjectStatus> {
  let profile: StatusCount;
  let approvedProfiles: ProjectStatus['approvedProfiles'] = [];
  try {
    const overview = await loadProfileOverview(session);
    const issues: StatusIssue[] = overview.rows.flatMap((row) => row.status === 'missing' || row.status === 'invalid'
      ? [{ state: row.status === 'missing' ? 'missing' as const : 'corrupt' as const, location: `system/${row.name}`, message: row.error ?? '画像文件缺失' }] : []);
    if (overview.crossCheck) issues.push({ state: 'incomplete', location: 'system', message: overview.crossCheck });
    profile = { total: overview.rows.length, pending: overview.rows.filter((row) => row.status !== 'approved').length, issues };
    approvedProfiles = overview.rows.flatMap(({ name, status, by }) => status === 'approved' && by !== undefined ? [{ name, by }] : []);
  } catch (error) { profile = { total: null, pending: null, issues: [{ state: 'corrupt', location: 'system', message: message(error) }] }; }
  const clauses = await loadCounts(session, 'clauses');
  const cases = await loadCounts(session, 'cases');
  if (clauses.total !== null && cases.total !== null && clauses.total > 0) {
    try {
      const active = new Set<string>();
      const covered = new Set<string>();
      for (const module of await session.artifacts.listModules('requirements')) {
        for (const row of await loadClauseRows(session, module)) if (row.clause.status === 'active') active.add(row.clause.id);
      }
      for (const module of await session.artifacts.listModules('cases')) {
        for (const row of (await loadCaseOverview(session, module)).rows) {
          for (const id of row.testCase.covers) covered.add(id);
        }
      }
      const uncovered = [...active].filter((id) => !covered.has(id)).sort();
      if (uncovered.length) cases.issues.push({ state: 'incomplete', location: 'cases', message: `条款尚无用例覆盖：${uncovered.join(', ')}` });
    } catch (error) {
      cases.total = null;
      cases.pending = null;
      cases.issues.push({ state: 'corrupt', location: 'cases', message: message(error) });
    }
  }
  const latestRun = await loadLatestRun(session);
  const incomplete = (count: StatusCount) => !count.total || count.pending !== 0 || count.issues.length > 0;
  const stage: StatusStage = incomplete(profile) ? 'profile' : incomplete(clauses) ? 'clauses' : incomplete(cases) ? 'cases' : latestRun.state === 'ready' ? 'results' : 'run';
  return { stage, profile, approvedProfiles, clauses, cases, latestRun };
}
