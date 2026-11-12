import { describe, expect, it, vi } from 'vitest';
import { callWithFallback, type ModelCandidate } from '../src/index';

const chain: ModelCandidate[] = [
  { ref: 'a:primary', model: 'primary' },
  { ref: 'b:backup', model: 'backup' },
];

describe('callWithFallback', () => {
  it('失败后指数退避重试', async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    const r = await callWithFallback(
      chain,
      async () => {
        if (++n < 3) throw new Error('503');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 500, sleep },
    );
    expect(r).toEqual({ value: 'ok', ref: 'a:primary', attempts: 3 });
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
  });

  it('主模型连续失败后切换备用模型', async () => {
    const onFallback = vi.fn();
    const r = await callWithFallback(
      chain,
      async (model) => {
        if (model === 'primary') throw new Error('down');
        return 'from backup';
      },
      { retries: 1, sleep: async () => {}, onFallback },
    );
    expect(r).toEqual({ value: 'from backup', ref: 'b:backup', attempts: 3 });
    expect(onFallback).toHaveBeenCalledWith('a:primary', 'b:backup', expect.any(Error));
  });

  it('全部失败时抛出最后一个错误', async () => {
    await expect(
      callWithFallback(chain, async (_m, ref) => Promise.reject(new Error(`fail ${ref}`)), { retries: 0, sleep: async () => {} }),
    ).rejects.toThrow('fail b:backup');
  });

  it('不可重试的错误立即抛出，不切换备用模型', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fn = vi.fn(async () => Promise.reject(abort));
    await expect(callWithFallback(chain, fn, { sleep: async () => {} })).rejects.toBe(abort);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
