import type { Approvals, ApprovalState } from '../approvals/approvals';
import type { Clause, TestCase } from '../schema/artifacts';
import { PROFILE_FILES, type Profile } from '../schema/profile';
import { loadProfile } from '../profile/load-profile';
import type { ArtifactStore } from '../store/artifact-store';

export class GateError extends Error {
  override name = 'GateError';
  constructor(
    message: string,
    readonly blockers: string[],
  ) {
    super(`${message}：\n${blockers.map((b) => `  - ${b}`).join('\n')}`);
  }
}

export interface Blocked {
  id: string;
  reason: string;
}

export interface Selection<T> {
  ready: T[];
  blocked: Blocked[];
}

const STATE_REASON: Record<Exclude<ApprovalState, 'approved'>, string> = {
  none: '未确认',
  stale: '确认已失效（内容已修改）',
};

/** 只有已确认、且状态为 active 的条款才能生成用例 */
export function selectPlannableClauses(clauses: Clause[], approvals: Approvals): Selection<Clause> {
  const sel: Selection<Clause> = { ready: [], blocked: [] };
  for (const c of clauses) {
    if (c.status !== 'active') {
      sel.blocked.push({ id: c.id, reason: `状态为 ${c.status}` });
      continue;
    }
    const st = approvals.state('clause', c.id, c);
    if (st !== 'approved') sel.blocked.push({ id: c.id, reason: STATE_REASON[st] });
    else sel.ready.push(c);
  }
  return sel;
}

/** 只有已确认、且覆盖的条款全部可用的用例才能执行 */
export function selectExecutableCases(
  cases: TestCase[],
  clauses: Clause[],
  approvals: Approvals,
): Selection<TestCase> {
  const usable = new Set(selectPlannableClauses(clauses, approvals).ready.map((c) => c.id));
  const sel: Selection<TestCase> = { ready: [], blocked: [] };
  for (const tc of cases) {
    const st = approvals.stateCase(tc, clauses);
    if (st !== 'approved') {
      sel.blocked.push({ id: tc.id, reason: STATE_REASON[st] });
      continue;
    }
    const missing = tc.covers.filter((id) => !usable.has(id));
    if (missing.length > 0) sel.blocked.push({ id: tc.id, reason: `覆盖的条款不可用：${missing.join(', ')}` });
    else sel.ready.push(tc);
  }
  return sel;
}

/** 画像文件（文件名 → 内容）必须全部已确认 */
export function assertProfileApproved(files: Record<string, unknown>, approvals: Approvals): void {
  const blockers: string[] = [];
  for (const name of PROFILE_FILES) {
    if (!Object.hasOwn(files, name) || files[name] === undefined) {
      blockers.push(`${name}：缺少必需画像文件`);
      continue;
    }
    const st = approvals.state('profile', name, files[name]);
    if (st !== 'approved') blockers.push(`${name}：${STATE_REASON[st]}`);
  }
  if (blockers.length > 0) throw new GateError('系统画像尚未全部确认', blockers);
}

/** 运行宿主必须调用这个入口，画像枚举不由调用方决定。 */
export async function assertStoredProfileApproved(store: ArtifactStore, approvals: Approvals): Promise<Profile> {
  const profile = await loadProfile(store);
  assertProfileApproved(profile, approvals);
  return profile;
}
