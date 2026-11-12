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

  it('remainingMs 返回剩余毫秒，用尽后不为负', () => {
    let t = 0;
    const b = new BudgetTracker(limits, () => t);
    expect(b.remainingMs()).toBe(60_000);
    t = 59_000;
    expect(b.remainingMs()).toBe(1_000);
    t = 70_000;
    expect(b.remainingMs()).toBe(0);
  });

  it('overrun：未超出时返回 null，且不检查步数', () => {
    const b = new BudgetTracker(limits, () => 0);
    b.recordStep();
    b.recordStep();
    b.recordTokens(50);
    expect(b.overrun()).toBeNull();
  });

  it('overrun：token 已用超过上限时返回原因', () => {
    const b = new BudgetTracker(limits, () => 0);
    b.recordTokens(101);
    expect(b.overrun()).toBe('token 预算耗尽（101/100）');
  });

  it('overrun：已用时长超过上限时返回原因', () => {
    let t = 0;
    const b = new BudgetTracker(limits, () => t);
    t = 60_001;
    expect(b.overrun()).toBe('时长预算耗尽（1 分钟）');
  });
});
