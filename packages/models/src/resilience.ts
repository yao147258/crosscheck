import { APICallError, type LanguageModel } from 'ai';
import type { ModelCandidate } from './resolve';

export interface ResilienceOptions {
  /** 每个模型的重试次数（不含首次），默认 3 */
  retries?: number;
  /** 首次退避时长，之后每次翻倍，默认 500ms */
  baseDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 中止信号：已中止或在退避等待期间中止，都会立即结束重试并抛出 */
  signal?: AbortSignal;
  onFallback?: (from: string, to: string, err: unknown) => void;
}

/** 默认退避等待：响应 signal，中止时立即结束等待（不等到超时） */
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });

type ErrorClass = 'abort' | 'non-retryable' | 'retryable';

/**
 * 错误分类：
 * - abort：err.name 为 AbortError/TimeoutError，或信号已中止 —— 立即抛出，不重试、不切换模型
 * - non-retryable：ai 包判定为不可重试的 APICallError（如 401/400）—— 跳过本模型剩余重试，直接切下一个候选
 * - retryable：其余情况（包含非 Error 抛出值）—— 指数退避后重试
 */
function classify(err: unknown, signal?: AbortSignal): ErrorClass {
  if (signal?.aborted) return 'abort';
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'abort';
  if (APICallError.isInstance(err) && err.isRetryable === false) return 'non-retryable';
  return 'retryable';
}

/** 依次尝试候选模型：每个模型指数退避重试，用尽后切换下一个 */
export async function callWithFallback<T>(
  chain: ModelCandidate[],
  fn: (model: LanguageModel, ref: string, candidate: ModelCandidate) => Promise<T>,
  opts: ResilienceOptions = {},
): Promise<{ value: T; ref: string; attempts: number }> {
  const { retries = 3, baseDelayMs = 500, sleep = defaultSleep, signal, onFallback } = opts;
  if (chain.length === 0) throw new Error('没有可用的模型');
  let attempts = 0;
  let lastErr: unknown;
  for (let c = 0; c < chain.length; c++) {
    const candidate = chain[c]!;
    const { ref, model } = candidate;
    for (let i = 0; i <= retries; i++) {
      signal?.throwIfAborted();
      attempts++;
      try {
        return { value: await fn(model, ref, candidate), ref, attempts };
      } catch (err) {
        const cls = classify(err, signal);
        if (cls === 'abort') throw err;
        lastErr = err;
        if (cls === 'non-retryable') break; // 跳过本模型剩余重试，直接切下一个候选
        if (i < retries) {
          await sleep(baseDelayMs * 2 ** i, signal);
          if (signal?.aborted) throw lastErr; // 退避期间中止：提前结束，不再重试
        }
      }
    }
    const next = chain[c + 1];
    if (next) onFallback?.(ref, next.ref, lastErr);
  }
  throw lastErr;
}
