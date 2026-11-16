import { z } from 'zod';
import { CaseIdSchema, ClauseIdSchema } from './artifacts';
import { RuntimeIdSchema } from './evidence';

/** 人对 FAIL / DISPUTED 预期的裁决 */
export const DECISIONS = ['confirmed_bug', 'false_positive', 'clause_issue'] as const;
export type Decision = (typeof DECISIONS)[number];

export const DispositionSchema = z.strictObject({
  caseId: CaseIdSchema,
  expectationId: z.string().regex(/^E\d+$/, '预期 id 形如 E1'),
  decision: z.enum(DECISIONS),
  /** 仅"条款有问题"时必填 */
  clauseId: ClauseIdSchema.optional(),
  note: z.string().default(''),
  by: z.string().min(1),
  at: z.iso.datetime(),
}).superRefine((value, ctx) => {
  if ((value.decision === 'clause_issue') !== (value.clauseId !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['clauseId'], message: '只有"条款有问题"需要且必须指定条款' });
  }
});
export type Disposition = z.infer<typeof DispositionSchema>;

export const DispositionsFileSchema = z.strictObject({
  version: z.literal(1),
  runId: RuntimeIdSchema,
  items: z.array(DispositionSchema),
});
export type DispositionsFile = z.infer<typeof DispositionsFileSchema>;

/** 同一用例 + 预期只保留最后一次裁决；不修改入参 */
export function upsertDisposition(file: DispositionsFile, item: Disposition): DispositionsFile {
  const rest = file.items.filter((d) => !(d.caseId === item.caseId && d.expectationId === item.expectationId));
  return { ...file, items: [...rest, item] };
}
