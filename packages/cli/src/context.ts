import { loadUserModelConfig, publicModelConfig, type ArtifactStore, type Config, type ProfileFile, type Role } from '@crosscheck/core';
import { createEvidenceRedactor } from '@crosscheck/tools';
import { createUsageObserver, hasProgressListener, resolveRole, withProgress, withoutOpenAIResponseStorage, type ModelCandidate, type UsageContext, type UsageEvent, type UsageObserver } from '@crosscheck/models';
import type { RunSuiteOptions } from '@crosscheck/runner';

import type { ReviewDependencies } from './review';

export type CommandDependencies = Pick<RunSuiteOptions, 'modelOptions' | 'resilience' | 'env' | 'userConfigHome' | 'usageContext' | 'usageObservationScope'> & {
  review?: ReviewDependencies;
  session?: { isTTY?: boolean };
  /** 会话内 /init 使用：提供后 init 不自己打开审核，而是把待确认画像交给会话。 */
  init?: { deferReview?: (only: ProfileFile[]) => void; disableResponseStorage?: boolean };
};

export function createCommandUsageObserver(
  project: string, command: UsageEvent['command'], role: UsageEvent['role'], pricing: Config['pricing'],
  deps: Pick<CommandDependencies, 'userConfigHome' | 'usageContext'>, log: UsageContext['warn'],
): UsageObserver {
  return createUsageObserver({ project, home: deps.userConfigHome, sessionId: deps.usageContext?.sessionId ?? null,
    command, role, pricing, warn: deps.usageContext?.warn ?? log });
}

export function withSessionUsageContext(deps: CommandDependencies, sessionId: string, warn: UsageContext['warn']): CommandDependencies {
  return { ...deps, usageContext: { sessionId, warn } };
}

export function createSessionTextNormalizer(apiKeys: string[] | null): (text: string) => string {
  return apiKeys === null
    ? () => '[无法确认配置密钥，已省略文本]'
    : createEvidenceRedactor([], apiKeys).displayText;
}

export class InterruptedError extends Error {
  override name = 'InterruptedError';
}

export async function withInterrupt<T>(
  signal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>, settle?: () => Promise<void>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    controller.signal.throwIfAborted();
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && (error === controller.signal.reason || error instanceof Error && error.name === 'AbortError')) {
      throw new InterruptedError('执行被中断；已完整写入的文件保留', { cause: error });
    }
    throw error;
  } finally {
    try {
      // 业务结果和异常分类已确定；收尾期间仍接管信号，但不重新判定取消。
      if (settle) await settle();
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export async function loadModelContext(artifacts: ArtifactStore, deps: CommandDependencies, userSnapshot?: Awaited<ReturnType<typeof loadUserModelConfig>>) {
  const project = await artifacts.loadProjectConfig();
  const user = userSnapshot ?? await loadUserModelConfig(deps.userConfigHome);
  const apiKeys = Object.fromEntries(Object.entries(user.providers).map(([name, provider]) => [name, provider.apiKey]));
  const config: Config = { ...project, ...publicModelConfig(user) };
  const redactor = createEvidenceRedactor([], Object.values(apiKeys).filter((key): key is string => !!key));
  return { config, deps: { ...deps, modelOptions: { ...deps.modelOptions, apiKeys } }, redactor };
}

/** 交互会话已登记进度监听时沿用会话显示；CLI 直接执行时把进度逐行写入日志。 */
export function withCliProgress<T>(log: (line: string) => void, fn: () => T): T {
  return hasProgressListener() ? fn() : withProgress(log, fn);
}

export function resolveModels(config: Config, role: Role, deps: CommandDependencies, log: (s: string) => void): ModelCandidate[] {
  const env = deps.env ?? deps.modelOptions?.env ?? process.env;
  const redactor = createEvidenceRedactor([], Object.values(deps.modelOptions?.apiKeys ?? {}).filter((key): key is string => !!key));
  try {
    const models = resolveRole(config, role, { ...deps.modelOptions, env, onWarning: (warning) => log(redactor.text(warning)) });
    return deps.init?.disableResponseStorage ? models.map(candidate => candidate.providerType === 'openai'
      ? { ...candidate, model: withoutOpenAIResponseStorage(candidate.model) } : candidate) : models;
  }
  catch (error) { throw new Error(redactor.text(error instanceof Error ? error.message : '模型配置失败')); }
}
