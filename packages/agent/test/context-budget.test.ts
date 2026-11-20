import { describe, expect, it } from 'vitest';
import { calibrate, deriveBudget, derivePolicy } from '../src/index';

describe('预算推导', () => {
  it('按窗口扣除输出预留、固定开销与安全余量', () => {
    expect(deriveBudget(256_000, 1_000)).toEqual({ window: 256_000, reserve: 32_000, fixed: 1_000, input: 221_976, attachments: 88_790 });
    expect(deriveBudget(40_000, 0)).toMatchObject({ reserve: 6_000, input: 32_976 });
    expect(deriveBudget(1_000, 500).input).toBe(0);
    expect(deriveBudget(undefined, 0).window).toBe(256_000);
  });

  it('策略按比例推导，以现有默认值为下限，显式值优先', () => {
    const policy = derivePolicy(deriveBudget(256_000, 0));
    expect(policy).toEqual({ maxToolChars: 8_000, maxEvidenceChars: 8_000, retainRecentToolRounds: 1, maxAttachmentChars: 89_190, maxAttachmentBytes: 8 * 1024 * 1024 });
    expect(derivePolicy(deriveBudget(1_000_000, 0)).maxToolChars).toBe(29_009);
    expect(derivePolicy(deriveBudget(256_000, 0), { maxToolChars: 50, retainRecentToolRounds: 2 })).toMatchObject({ maxToolChars: 50, retainRecentToolRounds: 2 });
  });

  it('校准系数只升不降，缺失或为 0 时忽略', () => {
    expect(calibrate(1, 100, 150)).toBe(1.5);
    expect(calibrate(1.5, 100, 120)).toBe(1.5);
    expect(calibrate(1.5, 100, undefined)).toBe(1.5);
    expect(calibrate(1.5, 0, 100)).toBe(1.5);
    expect(calibrate(1.5, 100, 0)).toBe(1.5);
  });
});
