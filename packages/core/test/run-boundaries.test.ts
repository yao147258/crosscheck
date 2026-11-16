import { describe, expect, it } from 'vitest';
import { CaseResultSchema, ExpectationResultSchema, RunManifestSchema, RunResultSchema } from '../src/index';

const time = '2026-11-13T00:00:00Z';
const judgement = { expectationId: 'E1', verdict: 'pass', evidenceIds: ['ev-1'], reasoning: '证据可见' };
const expectation = { expectationId: 'E1', executor: judgement, reviewer: judgement, status: 'PASS' };
const budget = { limits: { steps: 60, tokens: 400000, minutes: 10 }, used: { steps: 1, tokens: 5, elapsedMs: 100 }, exhausted: false, reason: null };
const result = { runId: 'run-1', caseId: 'M-TC-1', attempt: 1, start: time, end: time, budget, complete: true, status: 'PASS', expectations: [expectation], usage: { inputTokens: 3, outputTokens: 2, cost: 0.01, pricingKnown: true }, reliability: { attempts: 1, errors: [] }, suggestions: [], drift: [] };
const manifest = { version: 1, runId: 'run-1', fingerprint: `sha256:${'a'.repeat(64)}`, environment: 'local', selectedCaseIds: ['M-TC-1'], status: 'completed', start: time, end: time };

describe('运行状态不可伪装通过', () => {
  it('双方通过才是 PASS，缺判定或不一致不能传入 PASS', () => {
    expect(ExpectationResultSchema.safeParse(expectation).success).toBe(true);
    expect(ExpectationResultSchema.safeParse({ ...expectation, reviewer: null }).success).toBe(false);
    expect(ExpectationResultSchema.safeParse({ ...expectation, reviewer: { ...judgement, verdict: 'fail' } }).success).toBe(false);
    expect(ExpectationResultSchema.safeParse({ ...expectation, reviewer: { ...judgement, expectationId: 'E2' } }).success).toBe(false);
    expect(ExpectationResultSchema.safeParse({ ...expectation, reviewer: null, status: 'BLOCKED' }).success).toBe(true);
  });
  it('完整结果不能缺预期，重复预期和负 usage 拒绝', () => {
    expect(CaseResultSchema.safeParse(result).success).toBe(true);
    expect(CaseResultSchema.safeParse({ ...result, expectations: [], status: 'BLOCKED' }).success).toBe(false);
    expect(CaseResultSchema.safeParse({ ...result, expectations: [expectation, expectation] }).success).toBe(false);
    expect(CaseResultSchema.safeParse({ ...result, usage: { ...result.usage, cost: -1 } }).success).toBe(false);
  });
  it('manifest 校验重复选择、时间顺序与结束状态', () => {
    expect(RunManifestSchema.safeParse(manifest).success).toBe(true);
    expect(RunManifestSchema.safeParse({ ...manifest, selectedCaseIds: ['M-TC-1', 'M-TC-1'] }).success).toBe(false);
    expect(RunManifestSchema.safeParse({ ...manifest, end: null }).success).toBe(false);
    expect(RunManifestSchema.safeParse({ ...manifest, end: '2026-11-12T00:00:00Z' }).success).toBe(false);
    expect(RunManifestSchema.safeParse({ ...manifest, status: 'running', end: null }).success).toBe(true);
    expect(RunManifestSchema.safeParse({ ...manifest, end: '2026-11-13T00:00:00.001Z' }).success).toBe(true);
  });
  it('汇总禁止漏掉 BLOCKED、重复或多余用例及错误聚合状态', () => {
    const blocked = { ...result, caseId: 'M-TC-2', complete: false, status: 'BLOCKED', expectations: [], reason: '未确认' };
    const fullManifest = { ...manifest, selectedCaseIds: ['M-TC-1', 'M-TC-2'] };
    expect(RunResultSchema.safeParse({ version: 1, manifest: fullManifest, usage: { inputTokens: 6, outputTokens: 4, cost: 0.02, pricingKnown: true }, budget: { steps: 2, tokens: 10, elapsedMs: 200 }, cases: [result, blocked], status: 'BLOCKED' }).success).toBe(true);
    expect(RunResultSchema.safeParse({ version: 1, manifest: fullManifest, usage: result.usage, budget: budget.used, cases: [result], status: 'PASS' }).success).toBe(false);
    expect(RunResultSchema.safeParse({ version: 1, manifest, usage: { inputTokens: 6, outputTokens: 4, cost: 0.02, pricingKnown: true }, budget: { steps: 2, tokens: 10, elapsedMs: 200 }, cases: [result, result], status: 'PASS' }).success).toBe(false);
    expect(RunResultSchema.safeParse({ version: 1, manifest, usage: result.usage, budget: budget.used, cases: [blocked], status: 'BLOCKED' }).success).toBe(false);
    expect(RunResultSchema.safeParse({ version: 1, manifest: fullManifest, usage: { inputTokens: 6, outputTokens: 4, cost: 0.02, pricingKnown: true }, budget: { steps: 2, tokens: 10, elapsedMs: 200 }, cases: [result, blocked], status: 'PASS' }).success).toBe(false);
  });
});
