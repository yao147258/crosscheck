import type { Config } from '@crosscheck/core';

interface Bucket {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageTotals extends Bucket {
  byRole: Record<string, Bucket>;
}

/** 按角色累计 token 与费用（单价按每百万 token 计） */
export class UsageMeter {
  private readonly byRole = new Map<string, Bucket>();

  constructor(private readonly pricing: Config['pricing'] = {}) {}

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
