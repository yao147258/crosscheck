import { z } from 'zod';

export const ROLES = ['extractor', 'planner', 'executor', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export const PROVIDER_TYPES = ['anthropic', 'openai', 'google', 'deepseek', 'ollama', 'openai-compatible'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** provider:model，model 部分允许再含冒号（如 ollama:qwen2.5:7b） */
export const ModelRefSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*:.+$/, '模型写成 provider:model 形式');

const ProviderConfigSchema = z.object({
  type: z.enum(PROVIDER_TYPES),
  baseURL: z.string().url().optional(),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, '这里只写环境变量名').optional(),
});

const BudgetLimitsSchema = z.object({
  steps: z.number().int().positive().default(60),
  tokens: z.number().int().positive().default(400000),
  minutes: z.number().positive().default(10),
});
export type BudgetLimits = z.infer<typeof BudgetLimitsSchema>;

const baseConfigSchema = z.object({
  models: z.object({
    extractor: ModelRefSchema,
    planner: ModelRefSchema,
    executor: ModelRefSchema,
    reviewer: ModelRefSchema,
    fallback: z
      .object({
        extractor: ModelRefSchema.optional(),
        planner: ModelRefSchema.optional(),
        executor: ModelRefSchema.optional(),
        reviewer: ModelRefSchema.optional(),
      })
      .default({}),
  }),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  budget: z
    .object({
      perCase: BudgetLimitsSchema.optional(),
    })
    .optional(),
  /** 每百万 token 单价，键为模型引用 */
  pricing: z
    .record(ModelRefSchema, z.object({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() }))
    .default({}),
  requirementsDocs: z.array(z.string()).default([]),
  defaultEnvironment: z.string().optional(),
});

export const ConfigSchema = baseConfigSchema.transform((config) => {
  // 确保 budget 和 perCase 有完整的默认值
  if (!config.budget) {
    config.budget = {
      perCase: {
        steps: 60,
        tokens: 400000,
        minutes: 10,
      },
    };
  } else if (!config.budget.perCase) {
    config.budget.perCase = {
      steps: 60,
      tokens: 400000,
      minutes: 10,
    };
  } else {
    // 补全 perCase 中缺失的字段
    config.budget.perCase = {
      steps: config.budget.perCase.steps ?? 60,
      tokens: config.budget.perCase.tokens ?? 400000,
      minutes: config.budget.perCase.minutes ?? 10,
    };
  }
  return config as {
    models: typeof config.models;
    providers: Record<string, any>;
    budget: { perCase: { steps: number; tokens: number; minutes: number } };
    pricing: Record<string, any>;
    requirementsDocs: string[];
    defaultEnvironment?: string;
  };
});

export type Config = z.infer<typeof ConfigSchema>;
