import type { ExpectationStatus, Judgement } from '../schema/verdict';

export const SEVERITY: Record<ExpectationStatus, number> = {
  PASS: 0,
  UNCLEAR: 1,
  DISPUTED: 2,
  FAIL: 3,
  BLOCKED: 4,
};

/** 合议：null 表示该方判定缺失或已作废 */
export function decide(exec: Judgement | null, review: Judgement | null): ExpectationStatus {
  if (!exec || !review) return 'BLOCKED';
  if (exec.verdict === 'unclear' || review.verdict === 'unclear') return 'UNCLEAR';
  if (exec.verdict !== review.verdict) return 'DISPUTED';
  return exec.verdict === 'pass' ? 'PASS' : 'FAIL';
}

/** 用例结果取所有预期中最严重的状态；没有任何结果视为 BLOCKED */
export function worstStatus(statuses: ExpectationStatus[]): ExpectationStatus {
  if (statuses.length === 0) return 'BLOCKED';
  return statuses.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
}

/** 0 全部通过；1 有 FAIL；2 有 DISPUTED/UNCLEAR/BLOCKED 或没有执行任何用例 */
export function exitCodeFor(caseStatuses: ExpectationStatus[]): 0 | 1 | 2 {
  if (caseStatuses.includes('FAIL')) return 1;
  if (caseStatuses.length === 0 || caseStatuses.some((s) => s !== 'PASS')) return 2;
  return 0;
}
