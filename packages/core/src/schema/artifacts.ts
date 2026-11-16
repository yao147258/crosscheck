import { z } from 'zod';

/** 判定可以引用的证据类型 */
export const EVIDENCE_TYPES = ['screenshot', 'dom', 'network', 'console', 'db'] as const;
export const EvidenceTypeSchema = z.enum(EVIDENCE_TYPES);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const ClauseIdSchema = z.string().regex(/^[A-Za-z0-9_]+-AC-\d+$/, '条款 id 形如 M09-AC-003');
export const CaseIdSchema = z.string().regex(/^[A-Za-z0-9_]+-TC-\d+$/, '用例 id 形如 M09-TC-007');

export const SourceRefSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  excerpt: z.string(),
});

export const ClauseSchema = z.object({
  id: ClauseIdSchema,
  text: z.string().min(1),
  source: SourceRefSchema,
  status: z.enum(['active', 'unclear', 'removed']).default('active'),
  notes: z.string().default(''),
});
export type Clause = z.infer<typeof ClauseSchema>;

export const ExpectationSchema = z.object({
  id: z.string().regex(/^E\d+$/, '预期 id 形如 E1'),
  text: z.string().min(1),
  evidence: z.array(EvidenceTypeSchema).min(1, '至少声明一种证据类型'),
});
export type Expectation = z.infer<typeof ExpectationSchema>;

/** 数组内 id 唯一性校验 */
function uniqueIds<T extends { id: string }>(items: T[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) ctx.addIssue({ code: 'custom', message: `id 重复：${item.id}` });
    seen.add(item.id);
  }
}

export const TestCaseSchema = z.object({
  id: CaseIdSchema,
  covers: z.array(ClauseIdSchema).min(1),
  fixtures: z.array(z.string().min(1)).default([]),
  actor: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  expectations: z.array(ExpectationSchema).min(1).superRefine(uniqueIds),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const ModuleClausesSchema = z.array(ClauseSchema).superRefine(uniqueIds);
export const ModuleCasesSchema = z.array(TestCaseSchema).superRefine(uniqueIds);

/** 从条款或用例 ID 推断模块名，例如 M09-AC-003 → M09 */
export function moduleOfId(id: string): string {
  const match = /^([A-Za-z0-9_]+)-(?:AC|TC)-\d+$/.exec(id);
  if (!match) throw new Error(`无法从标识推断模块：${id}`);
  return match[1]!;
}
