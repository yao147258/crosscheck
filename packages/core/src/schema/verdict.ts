import { z } from 'zod';
import { EvidenceTypeSchema } from './artifacts';

export const JudgementSchema = z.object({
  expectationId: z.string().min(1),
  verdict: z.enum(['pass', 'fail', 'unclear']),
  evidenceIds: z.array(z.string()),
  reasoning: z.string(),
});
export type Judgement = z.infer<typeof JudgementSchema>;

export const EXPECTATION_STATUSES = ['PASS', 'FAIL', 'DISPUTED', 'UNCLEAR', 'BLOCKED'] as const;
export type ExpectationStatus = (typeof EXPECTATION_STATUSES)[number];

export const EvidenceRecordSchema = z.object({
  id: z.string().min(1),
  type: EvidenceTypeSchema,
  path: z.string().optional(),
  summary: z.string().optional(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
