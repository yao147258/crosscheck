import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { containsModelSecret, publicModelConfig, UserModelConfigSchema, type UserModelConfig } from '../schema/config';

const configDiagnostics = {
  missing: '找不到全局 ~/.crosscheck/config.yaml，请先配置模型和密钥',
  unreadable: '无法读取全局 ~/.crosscheck/config.yaml，请检查文件权限',
  invalid: '全局 ~/.crosscheck/config.yaml 格式或配置不合法',
} as const;

export class UserModelConfigError extends Error {
  override name = 'UserModelConfigError';
  constructor(readonly kind: keyof typeof configDiagnostics) { super(configDiagnostics[kind]); }
  get diagnostic(): string { return configDiagnostics[this.kind]; }
}

export type UserModelConfigSnapshot = { config: UserModelConfig; apiKeys: string[] } | { error: UserModelConfigError; apiKeys: string[] | null };

function isMapping(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 与模型校验分开提取：其他字段无效不意味着没有密钥；null 表示不能可靠提取。
function extractApiKeys(value: unknown): string[] | null {
  if (!isMapping(value)) return null;
  if (!Object.hasOwn(value, 'providers')) return [];
  if (!isMapping(value.providers)) return null;
  const keys: string[] = [];
  for (const provider of Object.values(value.providers)) {
    if (!isMapping(provider)) return null;
    if (!Object.hasOwn(provider, 'apiKey')) continue;
    if (typeof provider.apiKey !== 'string') return null;
    if (provider.apiKey.trim()) keys.push(provider.apiKey.trim());
  }
  return keys;
}

/** 同一次读取同时提供模型配置和归档脱敏所需的密钥；错误不附带原文或底层异常。 */
export async function loadUserModelConfigSnapshot(home = os.homedir()): Promise<UserModelConfigSnapshot> {
  let text: string;
  try { text = await readFile(path.join(home, '.crosscheck', 'config.yaml'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { error: new UserModelConfigError('missing'), apiKeys: [] };
    return { error: new UserModelConfigError('unreadable'), apiKeys: null };
  }
  let raw: unknown;
  try { raw = YAML.parse(text); }
  catch { return { error: new UserModelConfigError('invalid'), apiKeys: null }; }
  try {
    const config = UserModelConfigSchema.parse(raw);
    const apiKeys = Object.values(config.providers).flatMap(provider => provider.apiKey ? [provider.apiKey] : []);
    if (containsModelSecret(publicModelConfig(config), apiKeys)) throw new Error();
    return { config, apiKeys };
  } catch { return { error: new UserModelConfigError('invalid'), apiKeys: extractApiKeys(raw) }; }
}

export async function loadUserModelConfig(home?: string): Promise<UserModelConfig> {
  const snapshot = await loadUserModelConfigSnapshot(home);
  if ('error' in snapshot) throw snapshot.error;
  return snapshot.config;
}
