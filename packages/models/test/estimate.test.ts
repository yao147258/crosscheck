import { describe, expect, it } from 'vitest';
import { estimateTokens, IMAGE_TOKENS, outputTokenLimit, outputTokenLimitForEstimate } from '../src/index';

describe('estimateTokens 图片估算', () => {
  it('Uint8Array 按固定 token 计，不按 JSON 展开', () => {
    const message = { role: 'user', content: [{ type: 'file', data: new Uint8Array(200_000), mediaType: 'image/png' }] };
    const n = estimateTokens([message]);
    expect(n).toBeGreaterThanOrEqual(IMAGE_TOKENS);
    expect(n).toBeLessThan(IMAGE_TOKENS + 100);
  });

  it('Buffer 经 toJSON 后同样按图片计', () => {
    expect(estimateTokens([{ data: Buffer.alloc(200_000) }])).toBeLessThan(IMAGE_TOKENS + 100);
  });

  it('多张图片累加', () => {
    expect(estimateTokens([[new Uint8Array(10), new Uint8Array(10)]])).toBeGreaterThanOrEqual(2 * IMAGE_TOKENS);
  });

  it('附带大截图时 outputTokenLimit 不再误报超窗口', () => {
    expect(() => outputTokenLimit(256_000, ['系统', [{ type: 'file', data: new Uint8Array(500_000) }]])).not.toThrow();
  });

  it('outputTokenLimitForEstimate 与 outputTokenLimit 一致', () => {
    expect(outputTokenLimitForEstimate(32_000, estimateTokens(['abc']))).toBe(outputTokenLimit(32_000, ['abc']));
    expect(() => outputTokenLimitForEstimate(1_000, 5_000)).toThrow(/上下文窗口/);
  });
});
