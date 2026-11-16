import { ClauseSchema, contentHash, type ApprovalState, type Clause } from '@crosscheck/core';
import YAML from 'yaml';
import { editValidated, parseYamlWith } from '../io/edit-loop';
import type { EditorHost } from '../io/editor';
import type { ReviewSession } from '../io/session';

export interface ClauseRow { clause: Clause; approval: ApprovalState }

export async function listReviewModules(session: ReviewSession): Promise<string[]> {
  const modules = [...await session.artifacts.listModules('requirements'), ...await session.artifacts.listModules('cases')];
  return [...new Set(modules)].sort();
}

export async function loadClauseRows(session: ReviewSession, module: string): Promise<ClauseRow[]> {
  return (await session.artifacts.loadClauses(module)).map((clause) => ({ clause, approval: session.approvals.state('clause', clause.id, clause) }));
}

async function find(session: ReviewSession, module: string, id: string): Promise<{ clauses: Clause[]; clause: Clause }> {
  const clauses = await session.artifacts.loadClauses(module);
  const clause = clauses.find((item) => item.id === id);
  if (!clause) throw new Error(`条款不存在：${id}`);
  return { clauses, clause };
}

export async function approveClause(session: ReviewSession, module: string, id: string): Promise<string> {
  await session.mutate(async (approvals) => {
    const { clause } = await find(session, module, id);
    if (clause.status !== 'active') throw new Error(`只有 active 条款可以确认，${id} 当前为 ${clause.status}`);
    approvals.approve('clause', id, clause, session.reviewer);
  });
  return `已确认 ${id}`;
}

export async function revokeClause(session: ReviewSession, module: string, id: string): Promise<string> {
  await session.mutate(async (approvals) => {
    await find(session, module, id);
    approvals.revoke('clause', id);
  });
  return `已撤销 ${id} 的确认`;
}

/** 历史结果调用时在同一次会话修改内校验快照，避免检查后再获取会话的竞态。 */
export async function markClauseUnclear(session: ReviewSession, module: string, id: string, expected?: Clause): Promise<string> {
  await session.mutate(async (approvals) => {
    const { clauses, clause } = await find(session, module, id);
    if (expected && contentHash(clause) !== contentHash(expected)) throw new Error(`${id} 与历史快照相比已变化，拒绝过时裁决`);
    await session.artifacts.saveClauses(module, clauses.map((clause) => clause.id === id ? { ...clause, status: 'unclear' as const } : clause));
    approvals.revoke('clause', id);
  });
  return `${id} 已标记为 unclear`;
}

export async function deleteClause(session: ReviewSession, module: string, id: string): Promise<string> {
  await session.mutate(async (approvals) => {
    const { clauses } = await find(session, module, id);
    await session.artifacts.saveClauses(module, clauses.filter((clause) => clause.id !== id));
    approvals.revoke('clause', id);
  });
  return `已删除 ${id}`;
}

export async function approveAllClauses(session: ReviewSession, module: string): Promise<string> {
  let count = 0;
  await session.mutate(async (approvals) => {
    const pending = (await session.artifacts.loadClauses(module)).filter((clause) => clause.status === 'active' && approvals.state('clause', clause.id, clause) !== 'approved');
    for (const clause of pending) approvals.approve('clause', clause.id, clause, session.reviewer);
    count = pending.length;
  });
  return `已确认 ${count} 条条款`;
}

export async function editClause(session: ReviewSession, editor: EditorHost, module: string, id: string): Promise<string> {
  const { clause } = await find(session, module, id);
  const outcome = await editValidated(editor, YAML.stringify(clause, { lineWidth: 0 }), (text) => {
    const parsed = parseYamlWith(text, ClauseSchema);
    return parsed.ok && parsed.value.id !== id ? { ok: false, error: `不能修改条款 ID（应为 ${id}）` } : parsed;
  });
  if (outcome.status === 'cancelled') return '未修改';
  await session.mutate(async () => {
    const current = await find(session, module, id);
    if (contentHash(current.clause) !== contentHash(clause)) throw new Error(`${id} 在编辑期间已变化，请重新编辑`);
    await session.artifacts.saveClauses(module, current.clauses.map((item) => item.id === id ? outcome.value : item));
  });
  return `已保存 ${id}`;
}
