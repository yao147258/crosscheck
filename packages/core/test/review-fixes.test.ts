import { describe, expect, it } from 'vitest';
import { BudgetUsageSchema, CaseResultSchema, FixtureSchema, ProfileSchema, RunResultSchema, TraceEventSchema, UsageSchema } from '../src/index';

const time = '2026-11-13T00:00:00Z';
const usage = { inputTokens: 3, outputTokens: 2, cost: null, pricingKnown: false };
const budget = { limits: { steps: 60, tokens: 400000, minutes: 10 }, used: { steps: 1, tokens: 5, elapsedMs: 100 }, exhausted: false, reason: null };
const blocked = { runId: 'run-1', caseId: 'M-TC-1', attempt: 1, start: time, end: time, complete: false, status: 'BLOCKED', expectations: [], usage, budget, reliability: { attempts: 0, errors: [] }, suggestions: [], drift: [] };
const manifest = { version: 1, runId: 'run-1', fingerprint: `sha256:${'a'.repeat(64)}`, environment: 'local', selectedCaseIds: ['M-TC-1'], status: 'completed', start: time, end: time };
const fixture = { kind: 'sql', query: 'seed', params: [], connection: { kind: 'postgres', env: 'FIXTURE_DATABASE_URL' } };
const profile = () => ({
  'environments.yaml': { version: 1, environments: {} },
  'auth.yaml': { version: 1, actors: {} },
  'api-catalog.yaml': { version: 1, operations: {} },
  'pages.yaml': { version: 1, pages: {} },
  'data-model.yaml': { version: 1, connection: { kind: 'postgres', env: 'READONLY_DATABASE_URL' }, queries: { seed: { sql: 'select 1', parameters: [] } } },
  'fixtures.yaml': { version: 1, fixtures: { seed: fixture } },
  'guardrails.yaml': { allowedHosts: ['localhost'] },
});

describe('审查修复：独立准备数据库凭证', () => {
  it('SQL fixture 必须声明独立 env，普通查询仍只使用只读连接', () => {
    const parsed = ProfileSchema.safeParse(profile());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data['data-model.yaml'].connection?.env).toBe('READONLY_DATABASE_URL');
    const { connection: _, ...missing } = fixture;
    expect(FixtureSchema.safeParse(missing).success).toBe(false);
    expect(FixtureSchema.safeParse({ ...fixture, connection: { kind: 'postgres', env: 'postgres://secret' } }).success).toBe(false);
    const reused = profile();
    reused['fixtures.yaml'].fixtures.seed = { ...fixture, connection: { kind: 'postgres', env: 'READONLY_DATABASE_URL' } };
    expect(ProfileSchema.safeParse(reused).success).toBe(false);
  });
});

describe('审查修复：结构化动作轨迹', () => {
  const trace = { runId: 'run-1', caseId: 'M-TC-1', attempt: 1, actionId: 'a-1', phase: 'execution', time, event: 'success', message: '完成', action: { type: 'fill', locator: { strategy: 'css', value: '#password' }, input: { kind: 'secretRef', env: 'LOGIN_PASSWORD' } }, beforeEvidenceIds: ['ev-before'], afterEvidenceIds: ['ev-after'], result: { status: 'success', output: { changed: true }, error: null }, durationMs: 100 };
  it('解析后完整保留动作、定位器、secret引用、前后证据、结果与耗时', () => {
    const parsed = TraceEventSchema.parse(trace);
    expect(parsed).toEqual(trace);
    expect(TraceEventSchema.safeParse({ ...trace, action: { ...trace.action, input: { kind: 'redacted', value: { text: '[已脱敏]' }, redacted: true } } }).success).toBe(true);
  });
  it('拒绝缺结构化字段、未脱敏原值和非法 secret env、负耗时', () => {
    const { action: _, ...missing } = trace;
    expect(TraceEventSchema.safeParse(missing).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...trace, action: { ...trace.action, input: { kind: 'redacted', value: '明文', redacted: false } } }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...trace, action: { ...trace.action, input: { kind: 'secretRef', env: '真实密钥' } } }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...trace, durationMs: -1 }).success).toBe(false);
  });
});

describe('审查修复：未知费用与独立恢复提交点', () => {
  it('未知费用必须 null，已知零费用可表示，不能用0伪装未知', () => {
    expect(UsageSchema.safeParse(usage).success).toBe(true);
    expect(UsageSchema.safeParse({ ...usage, pricingKnown: true, cost: 0 }).success).toBe(true);
    expect(UsageSchema.safeParse({ ...usage, cost: 0 }).success).toBe(false);
    expect(UsageSchema.safeParse({ ...usage, pricingKnown: true }).success).toBe(false);
  });
  it('独立 case 必须保留 runId/attempt/起止时间及预算，拒绝不完整归属和倒序时间', () => {
    expect(CaseResultSchema.parse(blocked)).toEqual(blocked);
    for (const key of ['runId', 'attempt', 'start', 'end', 'budget']) {
      const missing: Record<string, unknown> = { ...blocked };
      delete missing[key];
      expect(CaseResultSchema.safeParse(missing).success).toBe(false);
    }
    expect(CaseResultSchema.safeParse({ ...blocked, attempt: 0 }).success).toBe(false);
    expect(CaseResultSchema.safeParse({ ...blocked, end: '2026-11-12T00:00:00Z' }).success).toBe(false);
    expect(CaseResultSchema.safeParse({ ...blocked, budget: { ...budget, used: { ...budget.used, steps: -1 } } }).success).toBe(false);
  });
  it.each(['steps', 'tokens'] as const)('大额预算 %s 汇总必须严格相等，不能接受多报1', (field) => {
    const used = { ...budget.used, [field]: 1_000_000_000 };
    const item = { ...blocked, budget: { ...budget, used } };
    const run = { version: 1, manifest, cases: [item], status: 'BLOCKED', usage, budget: used };
    expect(RunResultSchema.safeParse(run).success).toBe(true);
    expect(RunResultSchema.safeParse({ ...run, budget: { ...used, [field]: 1_000_000_001 } }).success).toBe(false);
  });
  it('计数拒绝超出安全整数，安全上界可表示，elapsedMs仍允许浮点容差', () => {
    for (const field of ['steps', 'tokens'] as const) {
      expect(BudgetUsageSchema.safeParse({ ...budget.used, [field]: Number.MAX_SAFE_INTEGER }).success).toBe(true);
      expect(BudgetUsageSchema.safeParse({ ...budget.used, [field]: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    }
    for (const field of ['inputTokens', 'outputTokens'] as const) {
      expect(UsageSchema.safeParse({ ...usage, [field]: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    }
    const run = { version: 1, manifest, cases: [blocked], status: 'BLOCKED', usage, budget: { ...budget.used, elapsedMs: 100.00000001 } };
    expect(RunResultSchema.safeParse(run).success).toBe(true);
  });
  it('汇总强制 case 归属一致并保存聚合 usage/budget，未知费用向上传播', () => {
    const run = { version: 1, manifest, cases: [blocked], status: 'BLOCKED', usage, budget: budget.used };
    expect(RunResultSchema.parse(run)).toEqual(run);
    expect(RunResultSchema.safeParse({ ...run, cases: [{ ...blocked, runId: 'other-run' }] }).success).toBe(false);
    expect(RunResultSchema.safeParse({ ...run, usage: { ...usage, inputTokens: 4 } }).success).toBe(false);
    expect(RunResultSchema.safeParse({ ...run, usage: { ...usage, pricingKnown: true, cost: 0 } }).success).toBe(false);
    expect(RunResultSchema.safeParse({ ...run, budget: { ...budget.used, tokens: 6 } }).success).toBe(false);
    const known = { ...blocked, caseId: 'M-TC-2', usage: { inputTokens: 7, outputTokens: 1, pricingKnown: true, cost: 0.1 } };
    const mixed = { ...run, manifest: { ...manifest, selectedCaseIds: ['M-TC-1', 'M-TC-2'] }, cases: [blocked, known], usage: { inputTokens: 10, outputTokens: 3, pricingKnown: false, cost: null }, budget: { steps: 2, tokens: 10, elapsedMs: 200 } };
    expect(RunResultSchema.safeParse(mixed).success).toBe(true);
    expect(RunResultSchema.safeParse({ ...mixed, usage: { ...mixed.usage, pricingKnown: true, cost: 0.1 } }).success).toBe(false);
    const knownRun = { ...run, cases: [{ ...blocked, usage: known.usage }], usage: known.usage };
    expect(RunResultSchema.safeParse(knownRun).success).toBe(true);
    expect(RunResultSchema.safeParse({ ...knownRun, usage: { ...known.usage, cost: 0.2 } }).success).toBe(false);
  });
});
