import { loadUserModelConfig, publicModelConfig, type ArtifactStore, type Config, type Role } from '@crosscheck/core';
import { createEvidenceRedactor } from '@crosscheck/tools';
import { hasProgressListener, resolveRole, withProgress, type ModelCandidate } from '@crosscheck/models';
import type { RunSuiteOptions } from '@crosscheck/runner';

import type { ReviewDependencies } from './review';

export type CommandDependencies = Pick<RunSuiteOptions, 'modelOptions' | 'resilience' | 'env' | 'userConfigHome'> & { review?: ReviewDependencies; session?: { isTTY?: boolean } };

export class InterruptedError extends Error {
  override name = 'InterruptedError';
}

export async function withInterrupt<T>(signal: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
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
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    signal?.removeEventListener('abort', abort);
  }
}

export async function loadModelContext(artifacts: ArtifactStore, deps: CommandDependencies) {
  const project = await artifacts.loadProjectConfig();
  const user = await loadUserModelConfig(deps.userConfigHome);
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
  try { return resolveRole(config, role, { ...deps.modelOptions, env, onWarning: (warning) => log(redactor.text(warning)) }); }
  catch (error) { throw new Error(redactor.text(error instanceof Error ? error.message : '模型配置失败')); }
}
