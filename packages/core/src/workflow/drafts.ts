import type { Approvals } from '../approvals/approvals';
import { moduleOfId, type Clause, type TestCase } from '../schema/artifacts';
import type { ArtifactStore } from '../store/artifact-store';

export interface DroppedDraft { id: string; reason: string }
export interface MergeResult<T> { items: T[]; kept: number; added: number; dropped: DroppedDraft[] }

const serial = (id: string): number => Number(/-(\d+)$/.exec(id)?.[1] ?? Number.NaN);

/** 按 ID 末尾编号升序，编号相同或无法解析时按字符串 */
export function compareArtifactIds(a: { id: string }, b: { id: string }): number {
  const diff = serial(a.id) - serial(b.id);
  return Number.isNaN(diff) || diff === 0 ? a.id.localeCompare(b.id) : diff;
}

/** 已确认条目原样保留；草稿中 ID 冲突或内容重复的丢弃 */
export function mergeDrafts<T extends { id: string }>(approved: T[], drafts: T[], duplicateKey?: (item: T) => string): MergeResult<T> {
  const ids = new Set(approved.map((item) => item.id));
  const keys = new Set(duplicateKey ? approved.map(duplicateKey) : []);
  const dropped: DroppedDraft[] = [];
  const accepted: T[] = [];
  for (const draft of drafts) {
    if (ids.has(draft.id)) { dropped.push({ id: draft.id, reason: '与已确认条目 ID 冲突' }); continue; }
    if (duplicateKey && keys.has(duplicateKey(draft))) { dropped.push({ id: draft.id, reason: '与已确认条目内容重复' }); continue; }
    ids.add(draft.id);
    accepted.push(draft);
  }
  return { items: [...approved, ...accepted].sort(compareArtifactIds), kept: approved.length, added: accepted.length, dropped };
}

export function clauseDuplicateKey(clause: Clause): string {
  return JSON.stringify([clause.source.file, clause.source.line, clause.text]);
}

export function partitionClauses(clauses: Clause[], approvals: Approvals): { approved: Clause[]; drafts: Clause[] } {
  const approved: Clause[] = [];
  const drafts: Clause[] = [];
  for (const c of clauses) (approvals.state('clause', c.id, c) === 'approved' ? approved : drafts).push(c);
  return { approved, drafts };
}

export function partitionCases(cases: TestCase[], clauses: Clause[], approvals: Approvals): { approved: TestCase[]; drafts: TestCase[] } {
  const approved: TestCase[] = [];
  const drafts: TestCase[] = [];
  for (const tc of cases) (approvals.stateCase(tc, clauses) === 'approved' ? approved : drafts).push(tc);
  return { approved, drafts };
}

/** clauses 中至少被一个用例覆盖的为 covered */
export function coverage(clauses: { id: string }[], cases: { covers: string[] }[]): { covered: string[]; uncovered: string[] } {
  const hit = new Set(cases.flatMap((tc) => tc.covers));
  return {
    covered: clauses.filter((c) => hit.has(c.id)).map((c) => c.id),
    uncovered: clauses.filter((c) => !hit.has(c.id)).map((c) => c.id),
  };
}

/** 按用例 covers 推断模块，加载这些模块的全部条款（用于用例确认的条款绑定） */
export async function loadCoveredClauses(store: ArtifactStore, cases: TestCase[]): Promise<Clause[]> {
  const modules = [...new Set(cases.flatMap((tc) => tc.covers.map(moduleOfId)))].sort();
  const result: Clause[] = [];
  for (const module of modules) result.push(...(await store.loadClauses(module)));
  return result;
}
