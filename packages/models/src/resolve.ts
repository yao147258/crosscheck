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
  /** 仅备用模型缺密钥可跳过；未提供回调时写标准警告。 */
  onWarning?: (warning: string) => void;
}

export class MissingModelKeyError extends ModelConfigError {}

function descriptor(ref: string, config: Config) {
  const { provider, modelId } = parseModelRef(ref);
  const custom = config.providers[provider];
  const type = custom?.type ?? (provider !== 'openai-compatible' && (PROVIDER_TYPES as readonly string[]).includes(provider) ? provider as ProviderType : undefined);
  if (!type || !(PROVIDER_TYPES as readonly string[]).includes(type)) throw new ModelConfigError(`未知的 provider：${provider}（请在 config.yaml 的 providers 中声明）`);
  if (type === 'openai-compatible' && !custom?.baseURL) throw new ModelConfigError(`provider ${provider} 是 openai-compatible，必须配置 baseURL`);
  if (custom?.baseURL) {
    let url: URL;
    try { url = new URL(custom.baseURL); } catch { throw new ModelConfigError(`provider ${provider} 的 baseURL 不合法`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ModelConfigError(`provider ${provider} 的 baseURL 不合法`);
  }
  return { provider, modelId, custom, type };
}

export function resolveModelRef(ref: string, config: Config, opts: ResolveOptions = {}): ModelCandidate {
  const env = opts.env ?? process.env;
  // 结构错误优先于缺 key，不能被 fallback 的跳过策略掩盖。
  const { provider, modelId, custom, type } = descriptor(ref, config);
  const keyEnv = custom?.apiKeyEnv ?? DEFAULT_KEY_ENV[type];
  const apiKey = keyEnv ? env[keyEnv] : undefined;
  if (keyEnv && !apiKey) throw new MissingModelKeyError(`模型 ${ref} 需要环境变量 ${keyEnv}`);
  const factory = opts.factories?.[type] ?? builtinFactories[type];
  return { ref, model: factory({ name: provider, modelId, apiKey, baseURL: custom?.baseURL }) };
}

/** 角色候选按主、备排列；主模型缺 key 必须报错，仅备用缺 key 可跳过。 */
export function resolveRole(config: Config, role: Role, opts: ResolveOptions = {}): ModelCandidate[] {
  const main = resolveModelRef(config.models[role], config, opts);
  const fallback = config.models.fallback[role];
  if (!fallback) return [main];
  try { return [main, resolveModelRef(fallback, config, opts)]; }
  catch (error) {
    if (!(error instanceof MissingModelKeyError)) throw error;
    (opts.onWarning ?? console.warn)(`跳过备用模型：${error.message}`);
    return [main];
  }
}

const DEFAULT_ENDPOINT: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com/v1', openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta', deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://localhost:11434/v1', 'openai-compatible': '',
};
function source(ref: string, config: Config) {
  const { type, custom } = descriptor(ref, config);
  const url = new URL(custom?.baseURL ?? DEFAULT_ENDPOINT[type]);
  url.hash = '';
  url.search = '';
  return { type, endpoint: url.toString().replace(/\/+$/, '') };
}

/** 主备组合均参加独立性提示；相同实际类型或规范 endpoint 只警告，不阻断。 */
export function vendorWarnings(config: Config): string[] {
  const exec = [config.models.executor, config.models.fallback.executor].filter((ref): ref is string => !!ref);
  const review = [config.models.reviewer, config.models.fallback.reviewer].filter((ref): ref is string => !!ref);
  const warnings: string[] = [];
  for (const a of exec) for (const b of review) {
    const left = source(a, config), right = source(b, config);
    if ((left.type === right.type && left.type !== 'openai-compatible') || left.endpoint === right.endpoint) warnings.push(`executor ${a} 与 reviewer ${b} 同厂商或同源 endpoint，交叉复核的独立性会减弱，建议换成不同厂商`);
  }
  return warnings;
}
