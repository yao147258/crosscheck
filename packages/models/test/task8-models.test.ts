import { ConfigSchema } from '@crosscheck/core';
import { describe, expect, it, vi } from 'vitest';
import { callWithFallback, resolveRole, vendorWarnings, UsageMeter, builtinFactories } from '../src/index';

const config = ConfigSchema.parse({ models: { extractor: 'openai:a', planner: 'ollama:a', executor: 'openai:a', reviewer: 'google:b', fallback: { executor: 'google:c' } } });
describe('Task8 模型边界', () => {
  it('备用缺 key 仅跳过并警告，主模型缺 key 仍失败', () => {
    const warnings: string[] = [];
    const chain = resolveRole(config, 'executor', { env: { OPENAI_API_KEY: 'test' }, onWarning: warning => warnings.push(warning) });
    expect(chain.map(c => c.ref)).toEqual(['openai:a']);
    expect(warnings.join()).toMatch(/google:c.*GOOGLE_GENERATIVE_AI_API_KEY/);
    expect(() => resolveRole(config, 'executor', { env: {}, onWarning: warning => warnings.push(warning) })).toThrow(/OPENAI_API_KEY/);
  });
  it('备用未知 provider 或缺 baseURL 不被缺 key 掩盖', () => {
    const bad = ConfigSchema.parse({ ...config, providers: { broken: { type: 'openai-compatible', apiKeyEnv: 'MISSING_KEY' } }, models: { ...config.models, fallback: { executor: 'broken:x' } } });
    expect(() => resolveRole(bad, 'executor', { env: { OPENAI_API_KEY: 'test' } })).toThrow(/baseURL/);
    const unknown = ConfigSchema.parse({ ...config, models: { ...config.models, fallback: { executor: 'unknown:x' } } });
    expect(() => resolveRole(unknown, 'executor', { env: { OPENAI_API_KEY: 'test' } })).toThrow(/未知/);
  });
  it('别名、规范 endpoint 和备用模型均参与同源警告', () => {
    const alias = ConfigSchema.parse({ ...config, providers: { alias: { type: 'openai', baseURL: 'https://API.OPENAI.COM:443/v1/' } }, models: { ...config.models, reviewer: 'alias:b' } });
    expect(vendorWarnings(alias).join()).toMatch(/独立性/);
    const fallback = ConfigSchema.parse({ ...config, models: { ...config.models, fallback: { reviewer: 'openai:b' } } });
    expect(vendorWarnings(fallback).join()).toMatch(/openai:b/);
    expect(vendorWarnings(config).join()).toMatch(/google:c/);
  });
  it('openai-compatible 不是厂商名，不同实际 endpoint 不误报同源', () => {
    const distinct = ConfigSchema.parse({ ...config, providers: {
      vendor_a: { type: 'openai-compatible', baseURL: 'https://a.example/v1' },
      vendor_b: { type: 'openai-compatible', baseURL: 'https://b.example/v1' },
    }, models: { ...config.models, executor: 'vendor_a:x', reviewer: 'vendor_b:y', fallback: {} } });
    expect(vendorWarnings(distinct)).toEqual([]);
  });
  it.each(['openai', 'google', 'deepseek', 'ollama', 'openai-compatible'] as const)('实际 %s 工厂只构造模型不联网', type => {
    const model = builtinFactories[type]({ name: type, modelId: 'local-test', apiKey: 'not-a-real-key', baseURL: type === 'openai-compatible' ? 'https://example.invalid/v1' : undefined });
    expect(model).toMatchObject({ modelId: 'local-test' });
  });
  it('已中止的 fallback 链在任何外部调用前拒绝', async () => {
    const signal = AbortSignal.abort(new Error('预先中止'));
    const fn = vi.fn(async () => 1);
    await expect(callWithFallback([{ ref: 'mock:a', model: 'mock' }], fn, { signal })).rejects.toThrow('预先中止');
    expect(fn).not.toHaveBeenCalled();
  });
  it('默认 sleep 正常结束与中止均移除监听器', async () => {
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, 'addEventListener');
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    let count = 0;
    await callWithFallback([{ ref: 'mock:a', model: 'mock' }], async () => { if (count++ === 0) throw new Error('503'); return 1; }, { signal: ac.signal, baseDelayMs: 1 });
    const handler = add.mock.calls.find(c => c[0] === 'abort')?.[1];
    expect(handler).toBeDefined();
    expect(remove.mock.calls.some(c => c[0] === 'abort' && c[1] === handler)).toBe(true);
    add.mockClear(); remove.mockClear();
    const promise = callWithFallback([{ ref: 'mock:a', model: 'mock' }], async () => { setTimeout(() => ac.abort(), 1); throw new Error('503'); }, { signal: ac.signal, baseDelayMs: 10000 });
    await expect(promise).rejects.toThrow('503');
    for (const call of add.mock.calls.filter(c => c[0] === 'abort')) expect(remove.mock.calls.some(c => c[1] === call[1])).toBe(true);
  });
  it('定价可按真实 ref 查询，未知成本是 null，未知 usage 不伪造 tokens', () => {
    const meter = new UsageMeter({ 'openai:a': { inputPerMTok: 2, outputPerMTok: 8 } });
    expect(meter.knownPricing('openai:a')).toBe(true);
    expect(meter.knownPricing('mock:unknown')).toBe(false);
    expect(meter.measure('mock:unknown', { inputTokens: 12, outputTokens: 4 })).toEqual({ inputTokens: 12, outputTokens: 4, pricingKnown: false, cost: null });
    expect(meter.measure('openai:a', {})).toEqual({ inputTokens: undefined, outputTokens: undefined, pricingKnown: true, cost: null });
    expect(meter.measure('openai:a', { inputTokens: 1000000, outputTokens: 500000 })).toMatchObject({ pricingKnown: true, cost: 6 });
  });
});
