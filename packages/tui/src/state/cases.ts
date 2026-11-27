import { TestCaseSchema, contentHash, coverage, loadCoveredClauses, selectPlannableClauses, type ApprovalState, type Clause, type TestCase } from '@crosscheck/core';
import YAML from 'yaml';
import { editValidated, parseYamlWith } from '../io/edit-loop';
import type { EditorHost } from '../io/editor';
import type { ReadonlyReviewContext, ReviewSession } from '../io/session';

export interface CaseRow { testCase: TestCase; approval: ApprovalState }
export interface CaseOverview {
  rows: CaseRow[];
  groups: { clauseId: string; caseIds: string[] }[];
  ungrouped: string[];
  coverage: { covered: string[]; uncovered: string[] };
}

function caseState(session: ReadonlyReviewContext, testCase: TestCase, clauses: Clause[], usable: Set<string>): ApprovalState {
  const state = session.approvals.stateCase(testCase, clauses);
  return state === 'approved' && testCase.covers.some((id) => !usable.has(id)) ? 'stale' : state;
}

export async function loadCaseOverview(session: ReadonlyReviewContext, module: string): Promise<CaseOverview> {
  const cases = await session.artifacts.loadCases(module);
  const moduleClauses = await session.artifacts.loadClauses(module);
  const coveredClauses = await loadCoveredClauses(session.artifacts, cases);
  const usable = new Set(selectPlannableClauses(coveredClauses, session.approvals).ready.map((clause) => clause.id));
  const rows = cases.map((testCase) => ({ testCase, approval: caseState(session, testCase, coveredClauses, usable) }));
  const ready = selectPlannableClauses(moduleClauses, session.approvals).ready;
  const groups = ready.map((clause) => ({ clauseId: clause.id, caseIds: cases.filter((testCase) => testCase.covers[0] === clause.id).map((testCase) => testCase.id) })).filter((group) => group.caseIds.length > 0);
  const grouped = new Set(groups.flatMap((group) => group.caseIds));
  return {
    rows,
    groups,
    ungrouped: cases.filter((testCase) => !grouped.has(testCase.id)).map((testCase) => testCase.id),
    coverage: coverage(ready, rows.filter((row) => row.approval === 'approved').map((row) => row.testCase)),
  };
}

async function find(session: ReviewSession, module: string, id: string): Promise<{ cases: TestCase[]; testCase: TestCase }> {
  const cases = await session.artifacts.loadCases(module);
  const testCase = cases.find((item) => item.id === id);
  if (!testCase) throw new Error(`用例不存在：${id}`);
  return { cases, testCase };
}

export async function approveCase(session: ReviewSession, module: string, id: string): Promise<string> {
  await session.mutate(async (approvals) => {
    const { testCase } = await find(session, module, id);
    const clauses = await loadCoveredClauses(session.artifacts, [testCase]);
    const usable = new Set(selectPlannableClauses(clauses, approvals).ready.map((clause) => clause.id));
    const missing = testCase.covers.filter((cover) => !usable.has(cover));
    if (missing.length) throw new Error(`覆盖的条款尚未确认或不是 active：${missing.join(', ')}`);
    approvals.approveCase(testCase, clauses, session.reviewer);
  });
  return `已确认 ${id}`;
}

export async function revokeCase(session: ReviewSession, module: string, id: string): Promise<string> {
  await session.mutate(async (approvals) => {
    await find(session, module, id);
    approvals.revoke('case', id);
  });
  return `已撤销 ${id} 的确认`;
}

export async function deleteCase(session: ReviewSession, module: string, id: string): Promise<string> {
  await session.mutate(async (approvals, stageWrite) => {
    const { cases } = await find(session, module, id);
    stageWrite('case', id, () => session.artifacts.saveCases(module, cases.filter((testCase) => testCase.id !== id)));
    approvals.revoke('case', id);
  });
  return `已删除 ${id}`;
}

export async function approveAllCases(session: ReviewSession, module: string): Promise<string> {
  let count = 0;
  let skipped = 0;
  await session.mutate(async (approvals) => {
    const cases = await session.artifacts.loadCases(module);
    const clauses = await loadCoveredClauses(session.artifacts, cases);
    const usable = new Set(selectPlannableClauses(clauses, approvals).ready.map((clause) => clause.id));
    for (const testCase of cases) {
      if (caseState({ artifacts: session.artifacts, approvals }, testCase, clauses, usable) === 'approved') continue;
      if (testCase.covers.some((id) => !usable.has(id))) { skipped++; continue; }
      approvals.approveCase(testCase, clauses, session.reviewer);
      count++;
    }
  });
  return `已确认 ${count} 个用例${skipped ? `，跳过 ${skipped} 个（覆盖的条款未全部确认）` : ''}`;
}

export async function editCase(session: ReviewSession, editor: EditorHost, module: string, id: string): Promise<string> {
  const { testCase } = await find(session, module, id);
  const outcome = await editValidated(editor, YAML.stringify(testCase, { lineWidth: 0 }), (text) => {
    const parsed = parseYamlWith(text, TestCaseSchema);
    return parsed.ok && parsed.value.id !== id ? { ok: false, error: `不能修改用例 ID（应为 ${id}）` } : parsed;
  });
  if (outcome.status === 'cancelled') return '未修改';
  await session.mutate(async (_approvals, stageWrite) => {
    const current = await find(session, module, id);
    if (contentHash(current.testCase) !== contentHash(testCase)) throw new Error(`${id} 在编辑期间已变化，请重新编辑`);
    stageWrite('case', id, () => session.artifacts.saveCases(module, current.cases.map((item) => item.id === id ? outcome.value : item)));
  });
  return `已保存 ${id}`;
}
