import { z } from 'zod';
import { JudgementSchema, checkJudgement, type EvidenceRecord, type Expectation, type Judgement } from '@crosscheck/core';
import type { TextEvidence, OutputValidation } from '@crosscheck/agent';
import type { EvidenceStore } from '@crosscheck/tools';

export const JudgementsSchema = z.strictObject({ judgements: z.array(JudgementSchema) });
export type JudgementsOutput = z.infer<typeof JudgementsSchema>;

/** 只从宿主当前 attempt 已登记的真实业务证据校验，不接收执行器摘要。 */
export async function validateJudgements(value: JudgementsOutput, expectations: Expectation[], records: EvidenceRecord[], store: EvidenceStore, shown: ReadonlyMap<string, TextEvidence>): Promise<OutputValidation> {
  const ids = value.judgements.map(j => j.expectationId);
  if (ids.length !== expectations.length || new Set(ids).size !== ids.length || expectations.some(e => !ids.includes(e.id))) return { ok: false, error: '每条预期必须恰有一个判定，不得额外、遗漏或重复' };
  const index = new Map(records.map(record => [record.id, record]));
  for (const j of value.judgements) {
    if (new Set(j.evidenceIds).size !== j.evidenceIds.length) return { ok: false, error: '证据 ID 重复' };
    for (const id of j.evidenceIds) {
      const record = index.get(id);
      if (!record || record.phase !== 'execution') return { ok: false, error: '证据不是本 attempt 真实业务采集记录' };
      await store.verify(record);
      const presentation = shown.get(id);
      if (!presentation || presentation.type !== record.type || presentation.truncated) return { ok: false, error: '引用证据未实际完整呈现（含源省略或截断）' };
    }
    const checked = checkJudgement(j, expectations.find(e => e.id === j.expectationId)!, index);
    if (!checked.ok) return { ok: false, error: checked.reason };
  }
  return { ok: true };
}

export function pairJudgements(expectations: Expectation[], judgements?: Judgement[]): Map<string, Judgement> {
  return new Map(expectations.flatMap(e => { const j = judgements?.find(item => item.expectationId === e.id); return j ? [[e.id, j] as const] : []; }));
}
