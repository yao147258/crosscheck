import { AsyncLocalStorage } from 'node:async_hooks';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { ProviderType } from '@crosscheck/core';
import type { LanguageModel } from 'ai';

export interface ProviderSettings {
  name: string;
  modelId: string;
  apiKey?: string;
  baseURL: string;
  fetch?: typeof globalThis.fetch;
}

export type ProviderFactory = (s: ProviderSettings) => LanguageModel;

interface BuiltinRequestBoundary {
  type: ProviderType;
  run<T>(onStart: () => void, generate: () => T): T;
}

const builtinRequests = new WeakMap<object, BuiltinRequestBoundary>();
const activeRequest = new AsyncLocalStorage<{ key: object; onStart: () => void }>();

/** 只识别内置适配器构造的实例，不从配置名推断注入模型。 */
export function getBuiltinRequestBoundary(model: object) {
  return builtinRequests.get(model);
}

function builtinFactory(type: ProviderType, create: (settings: ProviderSettings) => Exclude<LanguageModel, string>): ProviderFactory {
  return settings => {
    // 同一个候选可被并行调用；每次生成拥有独立的 fetch 通知。
    const key = {};
    const fetch: typeof globalThis.fetch = (input, init) => {
      const active = activeRequest.getStore();
      if (active?.key === key) active.onStart();
      return (settings.fetch ?? globalThis.fetch)(input, init);
    };
    const model = create({ ...settings, fetch });
    builtinRequests.set(model, { type, run: (onStart, generate) => activeRequest.run({ key, onStart }, generate) });
    return model;
  };
}

/** 为本次初始化关闭 Responses 服务端存储，保留原模型的请求边界与用量观察。 */
export function withoutOpenAIResponseStorage(model: LanguageModel): LanguageModel {
  if (typeof model === 'string') return model;
  const wrapped = new Proxy(model, {
    get(target, property) {
      if (property === 'doGenerate' || property === 'doStream') {
        const method = Reflect.get(target, property, target);
        return (options: { providerOptions?: Record<string, Record<string, unknown>> }) => Reflect.apply(method, target, [{
          ...options, providerOptions: { ...options.providerOptions, openai: { ...options.providerOptions?.openai, store: false } },
        }]);
      }
      return Reflect.get(target, property, target);
    },
  });
  const boundary = builtinRequests.get(model);
  if (boundary) builtinRequests.set(wrapped, boundary);
  return wrapped;
}

export const builtinFactories: Record<ProviderType, ProviderFactory> = {
  anthropic: builtinFactory('anthropic', s => createAnthropic({ apiKey: s.apiKey, baseURL: s.baseURL, fetch: s.fetch })(s.modelId)),
  openai: builtinFactory('openai', s => createOpenAI({ apiKey: s.apiKey, baseURL: s.baseURL, fetch: s.fetch })(s.modelId)),
};
