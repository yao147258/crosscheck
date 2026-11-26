import type { Config } from '@crosscheck/core';
import { parseModelRef } from './model-ref';

export type UsagePrice = Config['pricing'][string];

/** 优先使用完整引用的价格；无精确配置时回退到去除窗口后缀的模型。 */
export function lookupUsagePrice(pricing: Config['pricing'], ref: string): UsagePrice | null {
  const { provider, modelId } = parseModelRef(ref);
  const price = pricing[ref] ?? pricing[`${provider}:${modelId}`];
  if (!price) return null;
  const { inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok } = price;
  const valid = (value: number) => Number.isFinite(value) && value >= 0;
  if (!valid(inputPerMTok) || !valid(outputPerMTok)
    || (cacheReadPerMTok !== undefined && !valid(cacheReadPerMTok))
    || (cacheWritePerMTok !== undefined && !valid(cacheWritePerMTok))) return null;
  return {
    inputPerMTok, outputPerMTok,
    ...(cacheReadPerMTok === undefined ? {} : { cacheReadPerMTok }),
    ...(cacheWritePerMTok === undefined ? {} : { cacheWritePerMTok }),
  };
}

/** 缓存计数缺失时不假设为零；缓存属于输入 token 的一部分。 */
export function conservativeUsageCost(price: UsagePrice | null, usage: {
  inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
}): number | null {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  if (!price || inputTokens === null || outputTokens === null || cacheReadTokens === null || cacheWriteTokens === null
    || cacheReadTokens + cacheWriteTokens > inputTokens) return null;
  const cost = ((inputTokens - cacheReadTokens - cacheWriteTokens) * price.inputPerMTok
    + cacheReadTokens * (price.cacheReadPerMTok ?? price.inputPerMTok)
    + cacheWriteTokens * (price.cacheWritePerMTok ?? price.inputPerMTok)
    + outputTokens * price.outputPerMTok) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}

interface Bucket {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 已包含在 inputTokens 内的缓存读、写部分 */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface UsageTotals extends Bucket {
  byRole: Record<string, Bucket>;
}

/** 按角色累计 token 与费用（单价按每百万 token 计） */
export class UsageMeter {
  private readonly byRole = new Map<string, Bucket>();

  constructor(private readonly pricing: Config['pricing'] = {}) {}

  knownPricing(ref: string): boolean { return this.pricing[ref] !== undefined; }

  /** 精确事件供 runner 使用：缺价或任一 token 未知时 cost 为 null，不伪造失败用量。 */
  measure(ref: string, usage: TokenUsage) {
    const price = this.pricing[ref];
    const { inputTokens, outputTokens } = usage;
    let cost: number | null = null;
    if (price && inputTokens !== undefined && outputTokens !== undefined) {
      const read = usage.cacheReadTokens ?? 0;
      const write = usage.cacheWriteTokens ?? 0;
      const plain = Math.max(0, inputTokens - read - write);
      cost = (plain * price.inputPerMTok + read * (price.cacheReadPerMTok ?? price.inputPerMTok)
        + write * (price.cacheWritePerMTok ?? price.inputPerMTok) + outputTokens * price.outputPerMTok) / 1_000_000;
    }
    return { inputTokens, outputTokens, pricingKnown: !!price, cost };
  }

  /** 兼容旧聚合接口；未知成本不能由此推定已知，宿主应使用 measure。 */
  add(role: string, ref: string, usage: { inputTokens?: number; outputTokens?: number }): void {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const price = this.pricing[ref];
    const cost = price ? (input * price.inputPerMTok + output * price.outputPerMTok) / 1_000_000 : 0;
    const b = this.byRole.get(role) ?? { inputTokens: 0, outputTokens: 0, cost: 0 };
    b.inputTokens += input;
    b.outputTokens += output;
    b.cost += cost;
    this.byRole.set(role, b);
  }

  totals(): UsageTotals {
    const byRole = Object.fromEntries([...this.byRole].map(([k, v]) => [k, { ...v }]));
    const sum = (f: keyof Bucket) => Object.values(byRole).reduce((s, b) => s + b[f], 0);
    return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cost: sum('cost'), byRole };
  }
}
