import { describe, expect, it } from 'vitest';
import { BudgetTracker } from '../src/index';

function setup() {
  const clock = { t: 0 };
  const parent = new BudgetTracker({ steps: 10, tokens: 1000, minutes: 10 }, () => clock.t);
  return { clock, parent };
}

describe('BudgetTracker.child', () => {
  it('子账本记录同时计入父账本', () => {
    const { parent } = setup();
    parent.recordTokens(200); parent.recordStep();
    const child = parent.child();
    child.recordTokens(100); child.recordStep();
    expect(parent.snapshot()).toMatchObject({ steps: 2, tokens: 300 });
    expect(child.snapshot()).toMatchObject({ steps: 1, tokens: 100 });
  });

  it('上限为父剩余额度的一半', () => {
    const { parent } = setup();
    parent.recordTokens(200); parent.recordStep();
    const child = parent.child(); // 步数 floor(9×0.5)=4，token floor(800×0.5)=400，时长 5 分钟
    for (let i = 0; i < 4; i++) child.recordStep();
    expect(child.exhausted()).toMatch(/步数/);
    expect(parent.exhausted()).toBeNull();
    const other = parent.child();
    other.recordTokens(Math.floor((1000 - 200) * 0.5));
    expect(other.exhausted()).toMatch(/token/);
  });

  it('cap 更小时以 cap 为准', () => {
    const { parent } = setup();
    const child = parent.child({ tokens: 50 });
    child.recordTokens(50);
    expect(child.exhausted()).toMatch(/token/);
  });

  it('父账本耗尽时子账本同样耗尽，剩余时长不超过父', () => {
    const { clock, parent } = setup();
    const child = parent.child();
    clock.t = 4 * 60_000;
    expect(child.remainingMs()).toBeLessThanOrEqual(parent.remainingMs());
    clock.t = 5 * 60_000;
    expect(child.exhausted()).toMatch(/时长/);
    parent.recordTokens(1000);
    expect(parent.child().exhausted()).not.toBeNull();
  });

  it('remaining 返回三项剩余额度', () => {
    const { parent } = setup();
    parent.recordTokens(100); parent.recordStep();
    expect(parent.remaining()).toEqual({ steps: 9, tokens: 900, ms: 600_000 });
  });

  it('share 必须在 (0, 1] 内', () => {
    expect(() => setup().parent.child({}, 0)).toThrow(/比例/);
    expect(() => setup().parent.child({}, 1.5)).toThrow(/比例/);
  });
});
