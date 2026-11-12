import type { LanguageModel } from 'ai';
import type { ModelCandidate } from './resolve';

export interface ResilienceOptions {
  /** 每个模型的重试次数（不含首次），默认 3 */
  retries?: number;
  /** 首次退避时长，之后每次翻倍，默认 500ms */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (err: unknown) => boolean;
  onFallback?: (from: string, to: string, err: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultRetryable = (err: unknown) => !(err instanceof Error && err.name === 'AbortError');

/** 依次尝试候选模型：每个模型指数退避重试，用尽后切换下一个 */
export async function callWithFallback<T>(
  chain: ModelCandidate[],
  fn: (model: LanguageModel, ref: string) => Promise<T>,
  opts: ResilienceOptions = {},
): Promise<{ value: T; ref: string; attempts: number }> {
  const { retries = 3, baseDelayMs = 500, sleep = defaultSleep, isRetryable = defaultRetryable, onFallback } = opts;
  if (chain.length === 0) throw new Error('没有可用的模型');
  let attempts = 0;
  let lastErr: unknown;
  for (let c = 0; c < chain.length; c++) {
    const { ref, model } = chain[c]!;
    for (let i = 0; i <= retries; i++) {
      attempts++;
      try {
        return { value: await fn(model, ref), ref, attempts };
      } catch (err) {
        if (!isRetryable(err)) throw err;
        lastErr = err;
        if (i < retries) await sleep(baseDelayMs * 2 ** i);
      }
    }
    const next = chain[c + 1];
    if (next) onFallback?.(ref, next.ref, lastErr);
  }
  throw lastErr;
}
