import { z } from 'zod';
import { CaseIdSchema, EvidenceTypeSchema } from './artifacts';
import { EnvRefSchema, JsonValueSchema } from './profile';

export const RuntimeIdSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/, '运行标识只能包含字母、数字、下划线和短横线');
export const RelativeArtifactPathSchema = z.string().min(1).refine((value) => !/[\\:\x00-\x1f]/.test(value) && !value.startsWith('/') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), '工件路径必须是无路径逃逸的相对路径，使用正斜线');
export const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, '摘要必须是 sha256 十六进制');
export const PhaseSchema = z.enum(['preparation', 'execution', 'review', 'cleanup']);
export const EvidenceRecordSchema = z.object({
  id: RuntimeIdSchema,
  type: EvidenceTypeSchema,
  runId: RuntimeIdSchema,
  caseId: CaseIdSchema,
  attempt: z.number().int().positive(),
  actionId: RuntimeIdSchema,
  phase: PhaseSchema,
  time: z.iso.datetime(),
  mime: z.string().min(1),
  path: RelativeArtifactPathSchema,
  digest: DigestSchema,
  redacted: z.boolean(),
  summary: z.string().optional(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export const TraceInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('redacted'), value: JsonValueSchema, redacted: z.literal(true) }),
  z.strictObject({ kind: z.literal('secretRef'), env: EnvRefSchema }),
]);
export const TraceLocatorSchema = z.strictObject({ strategy: z.enum(['css', 'role', 'text', 'testId', 'xpath']), value: z.string().min(1), name: z.string().optional() });
export const TraceActionSchema = z.strictObject({ type: z.string().min(1), locator: TraceLocatorSchema.nullable(), input: TraceInputSchema.nullable() });
export const TraceActionResultSchema = z.strictObject({ status: z.enum(['pending', 'success', 'error', 'blocked']), output: JsonValueSchema, error: z.string().nullable() });
export const TraceEventSchema = z.strictObject({
  runId: RuntimeIdSchema,
  caseId: CaseIdSchema,
  attempt: z.number().int().positive(),
  actionId: RuntimeIdSchema,
  phase: PhaseSchema,
  time: z.iso.datetime(),
  event: z.enum(['start', 'success', 'error', 'blocked']),
  message: z.string(),
  action: TraceActionSchema,
  beforeEvidenceIds: z.array(RuntimeIdSchema),
  afterEvidenceIds: z.array(RuntimeIdSchema),
  result: TraceActionResultSchema,
  durationMs: z.number().nonnegative(),
}).superRefine((value, ctx) => {
  if (value.result.status !== (value.event === 'start' ? 'pending' : value.event)) ctx.addIssue({ code: 'custom', message: '轨迹事件与动作结果状态不一致' });
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;
