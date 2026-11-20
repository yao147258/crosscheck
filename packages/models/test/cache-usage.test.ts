import { ConfigSchema, publicModelConfig, UserModelConfigSchema } from '@crosscheck/core';
import { describe, expect, it } from 'vitest';
import { resolveModelRef, UsageMeter } from '../src/index';

describe('缓存计费', () => {
  it('缓存读写按各自单价计费', () => {
    const meter = new UsageMeter({ 'a:m': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 } });
    const r = meter.measure('a:m', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 600_000, cacheWriteTokens: 100_000 });
    expect(r.cost).toBeCloseTo(0.3 * 3 + 0.6 * 0.3 + 0.1 * 3.75);
  });

  it('未配置缓存价时按输入价计费，不判为未知', () => {
    const meter = new UsageMeter({ 'a:m': { inputPerMTok: 3, outputPerMTok: 15 } });
    const r = meter.measure('a:m', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 600_000 });
    expect(r).toMatchObject({ pricingKnown: true });
    expect(r.cost).toBeCloseTo(3);
  });

  it('pricing 接受可选缓存单价，公开投影保留且不凭空添加', () => {
    const user = UserModelConfigSchema.parse({
      models: { extractor: 'a:m', planner: 'a:m', executor: 'a:m', reviewer: 'a:m' },
      pricing: { 'a:m': { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1 }, 'a:n': { inputPerMTok: 1, outputPerMTok: 2 } },
    });
    const pub = publicModelConfig(user);
    expect(pub.pricing['a:m']).toEqual({ inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1 });
    expect(pub.pricing['a:n']).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
  });

  it('候选携带 provider 类型', () => {
    const config = ConfigSchema.parse({
      models: { extractor: 'cl:m', planner: 'cl:m', executor: 'cl:m', reviewer: 'cl:m' },
      providers: { cl: { type: 'anthropic', baseURL: 'https://api.example.com' } },
    });
    expect(resolveModelRef('cl:m', config, { apiKeys: { cl: 'k' } }).providerType).toBe('anthropic');
  });
});
