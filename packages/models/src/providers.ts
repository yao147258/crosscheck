import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { ProviderType } from '@crosscheck/core';
import type { LanguageModel } from 'ai';

export interface ProviderSettings {
  name: string;
  modelId: string;
  apiKey?: string;
  baseURL: string;
}

export type ProviderFactory = (s: ProviderSettings) => LanguageModel;

export const builtinFactories: Record<ProviderType, ProviderFactory> = {
  anthropic: (s) => createAnthropic({ apiKey: s.apiKey, baseURL: s.baseURL })(s.modelId),
  openai: (s) => createOpenAI({ apiKey: s.apiKey, baseURL: s.baseURL })(s.modelId),
};
