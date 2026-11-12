import type { Expectation } from '../schema/artifacts';
import type { EvidenceRecord, Judgement } from '../schema/verdict';

export type GuardResult = { ok: true } | { ok: false; reason: string };
export type EvidenceIndex = ReadonlyMap<string, EvidenceRecord>;

/** 判定必须引用真实存在的证据，且覆盖预期要求的全部证据类型 */
export function checkJudgement(j: Judgement, exp: Expectation, index: EvidenceIndex): GuardResult {
  if (j.expectationId !== exp.id) {
    return { ok: false, reason: `判定的预期 id ${j.expectationId} 与 ${exp.id} 不符` };
  }
  if (j.reasoning.trim() === '') return { ok: false, reason: '缺少判定理由' };
  // 条款模糊无法判定时，不强制附证据
  if (j.verdict === 'unclear') return { ok: true };

  if (j.evidenceIds.length === 0) return { ok: false, reason: '判定没有引用任何证据' };
  const missing = j.evidenceIds.filter((id) => !index.has(id));
  if (missing.length > 0) return { ok: false, reason: `引用了不存在的证据：${missing.join(', ')}` };

  const cited = new Set(j.evidenceIds.map((id) => index.get(id)!.type));
  const lacking = exp.evidence.filter((t) => !cited.has(t));
  if (lacking.length > 0) return { ok: false, reason: `缺少要求的证据类型：${lacking.join(', ')}` };
  return { ok: true };
}
