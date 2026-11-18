import { z } from 'zod';

export const ROLES = ['extractor', 'planner', 'executor', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export const PROVIDER_TYPES = ['anthropic', 'openai'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** provider:model，model 部分允许再含冒号（如 local:qwen2.5:7b） */
export const ModelRefSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*:.+$/, '模型写成 provider:model 形式');

const ProviderConfigSchema = z.object({
  type: z.enum(PROVIDER_TYPES),
  baseURL: z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }),
});

const UserProviderSchema = ProviderConfigSchema.extend({
  apiKey: z.string().trim().min(1).optional(),
});

export const BudgetLimitsSchema = z.object({
  steps: z.number().int().positive().default(60),
  tokens: z.number().int().positive().default(400000),
  minutes: z.number().positive().default(10),
});
export type BudgetLimits = z.infer<typeof BudgetLimitsSchema>;

export const ConfigSchema = z.object({
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
      .prefault({}),
  }),
  providers: z.record(z.string(), ProviderConfigSchema).prefault({}),
  /** 按完整模型引用登记能力，未登记的引用一律视为不支持图片，含备用模型。 */
  capabilities: z.record(ModelRefSchema, z.object({ images: z.boolean().default(false) })).prefault({}),
  budget: z.object({ perCase: BudgetLimitsSchema.prefault({}) }).prefault({}),
  /** 每百万 token 单价，键为模型引用 */
  pricing: z
    .record(ModelRefSchema, z.object({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() }))
    .prefault({}),
  requirementsDocs: z.array(z.string()).prefault([]),
  defaultEnvironment: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export const ProjectConfigSchema = ConfigSchema.pick({ budget: true, requirementsDocs: true, defaultEnvironment: true });
export const UserModelConfigSchema = ConfigSchema.pick({ models: true, capabilities: true, pricing: true }).extend({
  providers: z.record(z.string(), UserProviderSchema).prefault({}),
});
export type UserModelConfig = z.infer<typeof UserModelConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** 短密钥仅匹配完整字符串，避免将常见字符误当成凭据；长密钥也检查嵌入的明文及常见编码。 */
export function containsModelSecret(value: unknown, secrets: string[]): boolean {
  const variants = secrets.filter(Boolean).flatMap(secret => [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')].map(encoded => ({ encoded, short: secret.length < 8 })));
  const visit = (item: unknown): boolean => {
    if (typeof item === 'string') return variants.some(({ encoded, short }) => short ? item === encoded : item.includes(encoded));
    if (Array.isArray(item)) return item.some(visit);
    return !!item && typeof item === 'object' && Object.entries(item).some(([key, child]) => visit(key) || visit(child));
  };
  return visit(value);
}

/** 只投影允许持久化的字段，绝不派生或复制密钥。 */
export function publicModelConfig(config: UserModelConfig) {
  return {
    models: { extractor: config.models.extractor, planner: config.models.planner, executor: config.models.executor, reviewer: config.models.reviewer, fallback: Object.fromEntries(ROLES.flatMap(role => config.models.fallback[role] ? [[role, config.models.fallback[role]]] : [])) },
    providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, {
      type: provider.type, baseURL: provider.baseURL,
    }])),
    capabilities: Object.fromEntries(Object.entries(config.capabilities).map(([ref, capability]) => [ref, { images: capability.images }])),
    pricing: Object.fromEntries(Object.entries(config.pricing).map(([ref, price]) => [ref, { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok }])),
  };
}

