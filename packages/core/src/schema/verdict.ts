import { z } from 'zod';
export { EvidenceRecordSchema, type EvidenceRecord } from './evidence';

export const JudgementSchema = z.object({
  expectationId: z.string().min(1),
  verdict: z.enum(['pass', 'fail', 'unclear']),
  evidenceIds: z.array(z.string()),
  reasoning: z.string(),
});
export type Judgement = z.infer<typeof JudgementSchema>;

export const EXPECTATION_STATUSES = ['PASS', 'FAIL', 'DISPUTED', 'UNCLEAR', 'BLOCKED'] as const;
export type ExpectationStatus = (typeof EXPECTATION_STATUSES)[number];

export const ExpectationStatusSchema = z.enum(EXPECTATION_STATUSES);
