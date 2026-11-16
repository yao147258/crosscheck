import { APICallError, type LanguageModel } from 'ai';
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
    // 调整：sleep 现在总是以 (ms, signal) 两个参数调用，以便退避等待能响应中止信号；
    // 本测试未传 signal，第二个参数为 undefined
    expect(sleep.mock.calls).toEqual([[500, undefined], [1000, undefined]]);
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

  it('TimeoutError 不重试、不切换模型，立即抛出', async () => {
    const timeout = Object.assign(new Error('超时'), { name: 'TimeoutError' });
    const fn = vi.fn(async () => Promise.reject(timeout));
    await expect(callWithFallback(chain, fn, { sleep: async () => {} })).rejects.toBe(timeout);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('signal 已中止时立即抛出，不调用模型', async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn(async () => Promise.reject(new Error('503')));
    await expect(callWithFallback(chain, fn, { sleep: async () => {}, signal: ac.signal })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('APICallError.isRetryable=false（如 401）在主模型上只调用一次就切到备用模型', async () => {
    const onFallback = vi.fn();
    const unauthorized = new APICallError({
      message: '未授权',
      url: 'https://example.com',
      requestBodyValues: {},
      statusCode: 401,
      isRetryable: false,
    });
    const fn = vi.fn(async (model: LanguageModel) => {
      if (model === 'primary') throw unauthorized;
      return 'from backup';
    });
    const r = await callWithFallback(chain, fn, { retries: 3, sleep: async () => {}, onFallback });
    expect(r).toEqual({ value: 'from backup', ref: 'b:backup', attempts: 2 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onFallback).toHaveBeenCalledWith('a:primary', 'b:backup', unauthorized);
  });

  it('所有候选都因不可重试错误失败时，抛出最后一个错误', async () => {
    const unauthorized = new APICallError({
      message: '未授权',
      url: 'https://example.com',
      requestBodyValues: {},
      statusCode: 401,
      isRetryable: false,
    });
    const fn = vi.fn(async () => Promise.reject(unauthorized));
    await expect(callWithFallback(chain, fn, { retries: 3, sleep: async () => {} })).rejects.toBe(unauthorized);
    expect(fn).toHaveBeenCalledTimes(2); // 两个候选各调用一次，都不重试
  });

  it('退避期间 signal 中止会提前结束等待，不再重试', async () => {
    const ac = new AbortController();
    const fn = vi.fn(async () => Promise.reject(new Error('503')));
    const started = Date.now();
    setTimeout(() => ac.abort(), 10);
    await expect(
      callWithFallback(chain, fn, { retries: 5, baseDelayMs: 5_000, signal: ac.signal }),
    ).rejects.toThrow('503');
    expect(Date.now() - started).toBeLessThan(1_000); // 远小于 5000ms 的退避时长
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('非 Error 抛出值按可重试处理', async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    const r = await callWithFallback(
      chain,
      async () => {
        if (++n < 2) throw 'boom';
        return 'ok';
      },
      { retries: 3, sleep },
    );
    expect(r).toEqual({ value: 'ok', ref: 'a:primary', attempts: 2 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
