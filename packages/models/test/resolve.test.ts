import { ConfigSchema } from '@crosscheck/core';
import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  ModelConfigError,
  outputTokenLimit,
  parseModelRef,
  resolveRole,
  vendorWarnings,
  type ProviderFactory,
  type ProviderSettings,
} from '../src/index';

const seen: ProviderSettings[] = [];
// 假工厂：记录参数，返回字符串作为模型（LanguageModel 类型允许字符串）
const fake: ProviderFactory = (s) => {
  seen.push(s);
  return `${s.name}/${s.modelId}`;
};
const factories = {
  anthropic: fake,
  openai: fake,
};

const config = ConfigSchema.parse({
  models: {
    extractor: 'anthropic:claude-sonnet-4-6',
    planner: 'qwen:qwen2.5:7b',
    executor: 'openai:gpt-5.4',
    reviewer: 'qwen:qwen-max',
    fallback: { executor: 'anthropic:claude-sonnet-4-6' },
  },
  providers: {
    qwen: { type: 'openai', baseURL: 'https://dashscope.example/v1' },
    openai: { type: 'openai', baseURL: 'https://api.openai.com/v1' },
    anthropic: { type: 'anthropic', baseURL: 'https://api.anthropic.com/v1' },
  },
});

const apiKeys = { openai: 'sk-o', anthropic: 'sk-a', qwen: 'sk-q' };

describe('parseModelRef', () => {
  it('只在第一个冒号处切分', () => {
    expect(parseModelRef('ollama:qwen2.5:7b')).toMatchObject({ provider: 'ollama', modelId: 'qwen2.5:7b' });
  });

  it('格式错误时报错', () => {
    expect(() => parseModelRef('gpt')).toThrow(ModelConfigError);
  });

  it('未写后缀时上下文窗口默认 256K', () => {
    expect(parseModelRef('jy:deepseek-flash')).toEqual({ provider: 'jy', modelId: 'deepseek-flash', contextWindow: DEFAULT_CONTEXT_WINDOW });
    expect(DEFAULT_CONTEXT_WINDOW).toBe(256_000);
  });

  it.each([
    ['jy:deepseek-flash[1M]', 'deepseek-flash', 1_000_000],
    ['jy:deepseek-flash[200k]', 'deepseek-flash', 200_000],
    ['jy:x[1.5M]', 'x', 1_500_000],
    ['ollama:qwen2.5:7b[32768]', 'qwen2.5:7b', 32_768],
  ])('%s 解析出上下文窗口并从模型名去掉后缀', (ref, modelId, contextWindow) => {
    expect(parseModelRef(ref)).toMatchObject({ modelId, contextWindow });
  });

  it.each(['jy:x[]', 'jy:x[0]', 'jy:x[1G]', 'jy:x[abc]', 'jy:[1M]'])('非法后缀 %s 报错', (ref) => {
    expect(() => parseModelRef(ref)).toThrow(ModelConfigError);
  });
});

describe('outputTokenLimit', () => {
  it('窗口充足时取 128K 封顶', () => {
    expect(outputTokenLimit(1_000_000, ['短输入'])).toBe(MAX_OUTPUT_TOKENS);
    expect(MAX_OUTPUT_TOKENS).toBe(128_000);
  });

  it('输出上限为窗口减去估算输入', () => {
    // 3 万个中文字符按每字 1 token 估算
    const limit = outputTokenLimit(64_000, ['中'.repeat(30_000)]);
    expect(limit).toBeLessThanOrEqual(64_000 - 30_000);
    expect(limit).toBeGreaterThan(30_000);
  });

  it('输入超出窗口时抛出不可重试错误', () => {
    let error: unknown;
    try { outputTokenLimit(10_000, ['中'.repeat(20_000)]); } catch (e) { error = e; }
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(false);
    expect((error as Error).message).toMatch(/上下文窗口/);
  });
});

describe('未声明的 provider', () => {
  it.each(['openai', 'anthropic'])('内置名称 %s 也必须显式声明', provider => {
    const missing = ConfigSchema.parse({ ...config, models: { ...config.models, reviewer: `${provider}:x` }, providers: {} });
    expect(() => resolveRole(missing, 'reviewer', { apiKeys, factories })).toThrow(/provider/);
  });
});

describe('resolveRole', () => {
  it('主模型在前、备用模型在后', () => {
    const c = resolveRole(config, 'executor', { apiKeys, factories });
    expect(c.map((x) => x.ref)).toEqual(['openai:gpt-5.4', 'anthropic:claude-sonnet-4-6']);
    expect(c[0]?.model).toBe('openai/gpt-5.4');
  });

  it('候选携带上下文窗口，工厂收到去掉后缀的模型名', () => {
    seen.length = 0;
    const withWindow = ConfigSchema.parse({ ...config, models: { ...config.models, reviewer: 'qwen:qwen-max[1M]' } });
    const [candidate] = resolveRole(withWindow, 'reviewer', { apiKeys, factories });
    expect(candidate).toMatchObject({ ref: 'qwen:qwen-max[1M]', contextWindow: 1_000_000 });
    expect(seen[0]?.modelId).toBe('qwen-max');
  });

  it('密钥从独立的全局密钥集合读取', () => {
    seen.length = 0;
    resolveRole(config, 'reviewer', { apiKeys, factories });
    expect(seen[0]).toEqual({ name: 'qwen', modelId: 'qwen-max', apiKey: 'sk-q', baseURL: 'https://dashscope.example/v1' });
  });

  it('从独立的全局密钥集合读取密钥而不是环境变量', () => {
    seen.length = 0;
    resolveRole(config, 'reviewer', { env: { DASHSCOPE_API_KEY: 'wrong' }, apiKeys: { qwen: 'direct-key' }, factories });
    expect(seen[0]?.apiKey).toBe('direct-key');
  });

  it('本地 endpoint 同样需要密钥', () => {
    expect(() => resolveRole(config, 'planner', { env: {}, factories })).toThrow(/apiKey/);
  });

  it('缺少全局密钥时给出可读错误', () => {
    expect(() => resolveRole(config, 'executor', { env: {}, factories })).toThrow(/apiKey/);
  });

  it('未知的 provider 报错', () => {
    const bad = ConfigSchema.parse({ ...config, models: { ...config.models, reviewer: 'nope:x' } });
    expect(() => resolveRole(bad, 'reviewer', { apiKeys, factories })).toThrow(/未知的 provider：nope/);
  });
});

describe('vendorWarnings', () => {
  it('executor 与 reviewer 同厂商时警告', () => {
    const same = ConfigSchema.parse({ ...config, models: { ...config.models, reviewer: 'openai:gpt-5.4-mini' } });
    expect(vendorWarnings(same)).toHaveLength(1);
    expect(vendorWarnings(config)).toHaveLength(1);
  });
});
