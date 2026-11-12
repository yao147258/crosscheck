import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ProviderType } from '@crosscheck/core';
import type { LanguageModel } from 'ai';
import { ModelConfigError } from './model-ref';

export interface ProviderSettings {
  name: string;
  modelId: string;
  apiKey?: string;
  baseURL?: string;
}

export type ProviderFactory = (s: ProviderSettings) => LanguageModel;

/** 内置 provider 默认读取的环境变量 */
export const DEFAULT_KEY_ENV: Partial<Record<ProviderType, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export const builtinFactories: Record<ProviderType, ProviderFactory> = {
  anthropic: (s) => createAnthropic({ apiKey: s.apiKey, baseURL: s.baseURL })(s.modelId),
  openai: (s) => createOpenAI({ apiKey: s.apiKey, baseURL: s.baseURL })(s.modelId),
  google: (s) => createGoogleGenerativeAI({ apiKey: s.apiKey, baseURL: s.baseURL })(s.modelId),
  deepseek: (s) => createDeepSeek({ apiKey: s.apiKey, baseURL: s.baseURL })(s.modelId),
  // Ollama 走它的 OpenAI 兼容接口
  ollama: (s) =>
    createOpenAICompatible({ name: s.name, baseURL: s.baseURL ?? 'http://localhost:11434/v1', apiKey: s.apiKey })(
      s.modelId,
    ),
  'openai-compatible': (s) => {
    if (!s.baseURL) throw new ModelConfigError(`provider ${s.name} 是 openai-compatible，必须配置 baseURL`);
    return createOpenAICompatible({ name: s.name, baseURL: s.baseURL, apiKey: s.apiKey })(s.modelId);
  },
};
