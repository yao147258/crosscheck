import { PROVIDER_TYPES, type Config, type ProviderType, type Role } from '@crosscheck/core';
import type { LanguageModel } from 'ai';
import { ModelConfigError, parseModelRef } from './model-ref';
import { builtinFactories, DEFAULT_KEY_ENV, type ProviderFactory } from './providers';

export interface ModelCandidate {
  ref: string;
  model: LanguageModel;
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  factories?: Partial<Record<ProviderType, ProviderFactory>>;
}

function isBuiltin(name: string): name is ProviderType {
  return (PROVIDER_TYPES as readonly string[]).includes(name) && name !== 'openai-compatible';
}

export function resolveModelRef(ref: string, config: Config, opts: ResolveOptions = {}): ModelCandidate {
  const env = opts.env ?? process.env;
  const { provider, modelId } = parseModelRef(ref);
  const custom = config.providers[provider];
  let type: ProviderType;
  if (custom) type = custom.type;
  else if (isBuiltin(provider)) type = provider;
  else throw new ModelConfigError(`未知的 provider：${provider}（请在 config.yaml 的 providers 中声明）`);

  const keyEnv = custom?.apiKeyEnv ?? DEFAULT_KEY_ENV[type];
  let apiKey: string | undefined;
  if (keyEnv) {
    apiKey = env[keyEnv];
    if (!apiKey) throw new ModelConfigError(`模型 ${ref} 需要环境变量 ${keyEnv}`);
  }
  const factory = opts.factories?.[type] ?? builtinFactories[type];
  const model = factory({ name: provider, modelId, apiKey, baseURL: custom?.baseURL });
  return { ref, model };
}

/** 角色的候选模型：主模型在前，备用模型（若配置）在后 */
export function resolveRole(config: Config, role: Role, opts: ResolveOptions = {}): ModelCandidate[] {
  const refs = [config.models[role], config.models.fallback[role]].filter((r): r is string => !!r);
  return refs.map((r) => resolveModelRef(r, config, opts));
}

/** executor 与 reviewer 同厂商时给出警告（不阻止运行） */
export function vendorWarnings(config: Config): string[] {
  const a = parseModelRef(config.models.executor).provider;
  const b = parseModelRef(config.models.reviewer).provider;
  return a === b ? [`executor 与 reviewer 都使用 ${a}，交叉复核的独立性会减弱，建议换成不同厂商`] : [];
}
