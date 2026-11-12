import { ConfigSchema } from '@crosscheck/core';
import { describe, expect, it } from 'vitest';
import {
  ModelConfigError,
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
  google: fake,
  deepseek: fake,
  ollama: fake,
  'openai-compatible': fake,
};

const config = ConfigSchema.parse({
  models: {
    extractor: 'anthropic:claude-sonnet-4-6',
    planner: 'ollama:qwen2.5:7b',
    executor: 'openai:gpt-5.4',
    reviewer: 'qwen:qwen-max',
    fallback: { executor: 'anthropic:claude-sonnet-4-6' },
  },
  providers: {
    qwen: { type: 'openai-compatible', baseURL: 'https://dashscope.example/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' },
  },
});

const env = { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a', DASHSCOPE_API_KEY: 'sk-q' };

describe('parseModelRef', () => {
  it('只在第一个冒号处切分', () => {
    expect(parseModelRef('ollama:qwen2.5:7b')).toEqual({ provider: 'ollama', modelId: 'qwen2.5:7b' });
  });

  it('格式错误时报错', () => {
    expect(() => parseModelRef('gpt')).toThrow(ModelConfigError);
  });
});

describe('resolveRole', () => {
  it('主模型在前、备用模型在后', () => {
    const c = resolveRole(config, 'executor', { env, factories });
    expect(c.map((x) => x.ref)).toEqual(['openai:gpt-5.4', 'anthropic:claude-sonnet-4-6']);
    expect(c[0]?.model).toBe('openai/gpt-5.4');
  });

  it('密钥从配置指定的环境变量读取', () => {
    seen.length = 0;
    resolveRole(config, 'reviewer', { env, factories });
    expect(seen[0]).toEqual({ name: 'qwen', modelId: 'qwen-max', apiKey: 'sk-q', baseURL: 'https://dashscope.example/v1' });
  });

  it('ollama 不需要密钥', () => {
    expect(resolveRole(config, 'planner', { env: {}, factories })[0]?.ref).toBe('ollama:qwen2.5:7b');
  });

  it('缺少环境变量时给出可读错误', () => {
    expect(() => resolveRole(config, 'executor', { env: {}, factories })).toThrow(/OPENAI_API_KEY/);
  });

  it('未知的 provider 报错', () => {
    const bad = ConfigSchema.parse({ ...config, models: { ...config.models, reviewer: 'nope:x' } });
    expect(() => resolveRole(bad, 'reviewer', { env, factories })).toThrow(/未知的 provider：nope/);
  });
});

describe('vendorWarnings', () => {
  it('executor 与 reviewer 同厂商时警告', () => {
    const same = ConfigSchema.parse({ ...config, models: { ...config.models, reviewer: 'openai:gpt-5.4-mini' } });
    expect(vendorWarnings(same)).toHaveLength(1);
    expect(vendorWarnings(config)).toEqual([]);
  });
});
