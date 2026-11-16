import { z } from 'zod';
import { CaseIdSchema } from './artifacts';
import { DigestSchema, RuntimeIdSchema } from './evidence';
import { ProfileNameSchema } from './profile';
import { BudgetLimitsSchema } from './config';
import { ExpectationStatusSchema, JudgementSchema } from './verdict';
import { decide, worstStatus } from '../verdict/consensus';

export const RunManifestSchema = z.object({
  version: z.literal(1),
  runId: RuntimeIdSchema,
  fingerprint: DigestSchema,
  environment: ProfileNameSchema,
  selectedCaseIds: z.array(CaseIdSchema),
  status: z.enum(['pending', 'running', 'completed', 'aborted']),
  start: z.iso.datetime(),
  end: z.iso.datetime().nullable(),
}).superRefine((value, ctx) => {
  if (new Set(value.selectedCaseIds).size !== value.selectedCaseIds.length) ctx.addIssue({ code: 'custom', message: '选中用例 ID 重复' });
  if ((value.status === 'completed' || value.status === 'aborted') && value.end === null) ctx.addIssue({ code: 'custom', message: '结束运行必须记录结束时间' });
  if (value.end !== null && Date.parse(value.end) < Date.parse(value.start)) ctx.addIssue({ code: 'custom', message: '结束时间不能早于开始时间' });
});
export type RunManifest = z.infer<typeof RunManifestSchema>;
export const UsageSchema = z.discriminatedUnion('pricingKnown', [
  z.strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), pricingKnown: z.literal(true), cost: z.number().nonnegative() }),
  z.strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), pricingKnown: z.literal(false), cost: z.null() }),
]);
export type Usage = z.infer<typeof UsageSchema>;
export const BudgetUsageSchema = z.strictObject({ steps: z.number().int().nonnegative(), tokens: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative() });
export const CaseBudgetSchema = z.strictObject({ limits: BudgetLimitsSchema, used: BudgetUsageSchema, exhausted: z.boolean(), reason: z.string().min(1).nullable() }).superRefine((value, ctx) => {
  if (value.exhausted !== (value.reason !== null)) ctx.addIssue({ code: 'custom', message: '预算耗尽状态必须与原因一致' });
});
export type BudgetUsage = z.infer<typeof BudgetUsageSchema>;
export type CaseBudget = z.infer<typeof CaseBudgetSchema>;
export const ExpectationResultSchema = z.object({
  expectationId: z.string().regex(/^E\d+$/),
  executor: JudgementSchema.nullable(),
  reviewer: JudgementSchema.nullable(),
  status: ExpectationStatusSchema,
}).superRefine((value, ctx) => {
  for (const judgement of [value.executor, value.reviewer]) if (judgement && judgement.expectationId !== value.expectationId) ctx.addIssue({ code: 'custom', message: '双方判定必须对应同一预期' });
  if (decide(value.executor, value.reviewer) !== value.status) ctx.addIssue({ code: 'custom', message: '预期状态与双方判定不一致' });
});
export type ExpectationResult = z.infer<typeof ExpectationResultSchema>;
export const CaseResultSchema = z.object({
  runId: RuntimeIdSchema,
  caseId: CaseIdSchema,
  attempt: z.number().int().positive(),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  budget: CaseBudgetSchema,
  complete: z.boolean(),
  status: ExpectationStatusSchema,
  expectations: z.array(ExpectationResultSchema),
  usage: UsageSchema,
  reliability: z.object({ attempts: z.number().int().nonnegative(), errors: z.array(z.string()) }),
  suggestions: z.array(z.string()),
  drift: z.array(z.string()),
  reason: z.string().optional(),
}).superRefine((value, ctx) => {
  if (Date.parse(value.end) < Date.parse(value.start)) ctx.addIssue({ code: 'custom', message: '用例结束时间不能早于开始时间' });
  if (new Set(value.expectations.map((e) => e.expectationId)).size !== value.expectations.length) ctx.addIssue({ code: 'custom', message: '预期结果 ID 重复' });
  if (value.complete && value.expectations.length === 0) ctx.addIssue({ code: 'custom', message: '完整用例结果不能缺少预期' });
  const expected = value.complete ? worstStatus(value.expectations.map((e) => e.status)) : 'BLOCKED';
  if (value.status !== expected) ctx.addIssue({ code: 'custom', message: '用例状态与完成情况或预期结果不一致' });
});
export type CaseResult = z.infer<typeof CaseResultSchema>;
export const RunResultSchema = z.object({ version: z.literal(1), manifest: RunManifestSchema, cases: z.array(CaseResultSchema), status: ExpectationStatusSchema, usage: UsageSchema, budget: BudgetUsageSchema }).superRefine((value, ctx) => {
  if (value.cases.some((item) => item.runId !== value.manifest.runId)) ctx.addIssue({ code: 'custom', message: '用例结果的 runId 必须与运行清单一致' });
  const inputTokens = value.cases.reduce((sum, item) => sum + item.usage.inputTokens, 0);
  const outputTokens = value.cases.reduce((sum, item) => sum + item.usage.outputTokens, 0);
  const pricingKnown = value.cases.every((item) => item.usage.pricingKnown);
  const cost = pricingKnown ? value.cases.reduce((sum, item) => sum + (item.usage.cost ?? 0), 0) : null;
  if (value.usage.inputTokens !== inputTokens || value.usage.outputTokens !== outputTokens || value.usage.pricingKnown !== pricingKnown || (cost === null ? value.usage.cost !== null : value.usage.cost === null || Math.abs(value.usage.cost - cost) > 1e-9 * Math.max(1, cost))) ctx.addIssue({ code: 'custom', message: '运行用量汇总必须与所有用例一致，未知费用不能记为零' });
  for (const field of ['steps', 'tokens', 'elapsedMs'] as const) {
    const sum = value.cases.reduce((total, item) => total + item.budget.used[field], 0);
    const mismatch = field === 'elapsedMs'
      ? Math.abs(value.budget[field] - sum) > 1e-9 * Math.max(1, sum)
      : value.budget[field] !== sum;
    if (mismatch) ctx.addIssue({ code: 'custom', message: `运行预算消耗汇总不一致：${field}` });
  }
  const selected = value.manifest.selectedCaseIds;
  const ids = value.cases.map((c) => c.caseId);
  if (new Set(ids).size !== ids.length || selected.length !== ids.length || selected.some((id) => !ids.includes(id))) ctx.addIssue({ code: 'custom', message: '运行结果必须包含每个选中用例（包括 BLOCKED），且不能重复或额外添加' });
  if (value.status !== worstStatus(value.cases.map((c) => c.status))) ctx.addIssue({ code: 'custom', message: '运行状态与用例结果不一致' });
});
export type RunResult = z.infer<typeof RunResultSchema>;
