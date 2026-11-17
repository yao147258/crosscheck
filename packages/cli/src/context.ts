import type { Config, Role } from '@crosscheck/core';
import { resolveRole, type ModelCandidate } from '@crosscheck/models';
import type { RunSuiteOptions } from '@crosscheck/runner';

import type { ReviewDependencies } from './review';

export type CommandDependencies = Pick<RunSuiteOptions, 'modelOptions' | 'resilience' | 'env'> & { review?: ReviewDependencies; session?: { isTTY?: boolean } };

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

export function resolveModels(config: Config, role: Role, deps: CommandDependencies, log: (s: string) => void): ModelCandidate[] {
  const env = deps.env ?? deps.modelOptions?.env ?? process.env;
  return resolveRole(config, role, { ...deps.modelOptions, env, onWarning: log });
}
