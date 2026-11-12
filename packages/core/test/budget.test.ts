import { describe, expect, it } from 'vitest';
import { BudgetTracker } from '../src/index';

describe('BudgetTracker', () => {
  const limits = { steps: 2, tokens: 100, minutes: 1 };

  it('未超出时返回 null', () => {
    const b = new BudgetTracker(limits, () => 0);
    b.recordStep();
    b.recordTokens(50);
    expect(b.exhausted()).toBeNull();
    expect(b.snapshot()).toEqual({ steps: 1, tokens: 50, elapsedMs: 0 });
  });

  it('步数用尽', () => {
    const b = new BudgetTracker(limits, () => 0);
    b.recordStep();
    b.recordStep();
    expect(b.exhausted()).toBe('步数预算耗尽（2/2）');
  });

  it('token 用尽', () => {
    const b = new BudgetTracker(limits, () => 0);
    b.recordTokens(100);
    expect(b.exhausted()).toBe('token 预算耗尽（100/100）');
  });

  it('时长用尽', () => {
    let t = 1000;
    const b = new BudgetTracker(limits, () => t);
    t += 60_000;
    expect(b.exhausted()).toBe('时长预算耗尽（1 分钟）');
  });
});
