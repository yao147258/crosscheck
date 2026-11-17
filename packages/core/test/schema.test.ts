import { describe, expect, it } from 'vitest';
import {
  ClauseSchema,
  ConfigSchema,
  GuardrailsSchema,
  JudgementSchema,
  ModuleCasesSchema,
  ModuleClausesSchema,
  TestCaseSchema,
} from '../src/index';

const clause = {
  id: 'M09-AC-003',
  text: '"为什么是 X 票？"正确列出成员身份',
  source: { file: 'doc/M09.md', line: 439, excerpt: '原文' },
};

const testCase = {
  id: 'M09-TC-007',
  covers: ['M09-AC-003'],
  fixtures: ['reset'],
  actor: 'member',
  steps: ['打开投票中提案详情页'],
  expectations: [{ id: 'E1', text: '列出成员身份', evidence: ['screenshot', 'dom'] }],
};

describe('ClauseSchema', () => {
  it('补全默认的 status 与 notes', () => {
    const c = ClauseSchema.parse(clause);
    expect(c.status).toBe('active');
    expect(c.notes).toBe('');
  });

  it('拒绝不合规的 id', () => {
    expect(ClauseSchema.safeParse({ ...clause, id: 'AC3' }).success).toBe(false);
  });

  it('模块内 id 重复时报错', () => {
    expect(ModuleClausesSchema.safeParse([clause, clause]).success).toBe(false);
  });
});

describe('TestCaseSchema', () => {
  it('解析合法用例', () => {
    expect(TestCaseSchema.parse(testCase).expectations[0]?.evidence).toEqual(['screenshot', 'dom']);
  });

  it('预期必须声明至少一种证据类型', () => {
    const bad = { ...testCase, expectations: [{ id: 'E1', text: 'x', evidence: [] }] };
    expect(TestCaseSchema.safeParse(bad).success).toBe(false);
  });

  it('未知证据类型被拒绝', () => {
    const bad = { ...testCase, expectations: [{ id: 'E1', text: 'x', evidence: ['video'] }] };
    expect(TestCaseSchema.safeParse(bad).success).toBe(false);
  });

  it('模块内用例 id 重复时报错', () => {
    expect(ModuleCasesSchema.safeParse([testCase, testCase]).success).toBe(false);
  });
});

describe('ConfigSchema', () => {
  const models = {
    extractor: 'anthropic:claude-sonnet-4-6',
    planner: 'deepseek:deepseek-chat',
    executor: 'openai:gpt-5.4',
    reviewer: 'qwen:qwen-max',
  };

  it('补全预算默认值', () => {
    const cfg = ConfigSchema.parse({ models });
    expect(cfg.budget.perCase).toEqual({ steps: 60, tokens: 400000, minutes: 10 });
    expect(cfg.models.fallback).toEqual({});
    expect(cfg.providers).toEqual({});
  });

  it('budget 为空对象时补全 perCase 默认值', () => {
    const cfg = ConfigSchema.parse({ models, budget: {} });
    expect(cfg.budget.perCase).toEqual({ steps: 60, tokens: 400000, minutes: 10 });
  });

  it('budget.perCase 部分字段时补全其他字段', () => {
    const cfg = ConfigSchema.parse({ models, budget: { perCase: { steps: 5 } } });
    expect(cfg.budget.perCase).toEqual({ steps: 5, tokens: 400000, minutes: 10 });
  });

  it('模型引用必须是 provider:model 形式', () => {
    expect(ConfigSchema.safeParse({ models: { ...models, executor: 'gpt-5.4' } }).success).toBe(false);
  });

  it('公开 provider 配置不保留秘密或旧环境变量名', () => {
    const cfg = ConfigSchema.parse({
      models,
      providers: {
        qwen: {
          type: 'openai-compatible',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKeyEnv: 'DASHSCOPE_API_KEY',
        },
      },
    });
    expect(cfg.providers.qwen).not.toHaveProperty('apiKeyEnv');
  });
});

describe('GuardrailsSchema', () => {
  it('白名单不能为空', () => {
    expect(GuardrailsSchema.safeParse({ allowedHosts: [] }).success).toBe(false);
  });

  it('补全默认值', () => {
    const g = GuardrailsSchema.parse({ allowedHosts: ['localhost:3000'] });
    expect(g.forbidden).toEqual([]);
    expect(g.redactFields).toEqual([]);
  });
});

describe('JudgementSchema', () => {
  it('verdict 只能是 pass/fail/unclear', () => {
    const j = { expectationId: 'E1', verdict: 'ok', evidenceIds: [], reasoning: 'x' };
    expect(JudgementSchema.safeParse(j).success).toBe(false);
  });
});
