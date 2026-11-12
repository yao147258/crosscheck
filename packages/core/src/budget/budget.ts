import type { BudgetLimits } from '../schema/config';

/** 单个用例的步数 / token / 时长预算 */
export class BudgetTracker {
  private steps = 0;
  private tokens = 0;
  private readonly startedAt: number;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  recordStep(): void {
    this.steps++;
  }

  recordTokens(n: number): void {
    this.tokens += n;
  }

  /** 已耗尽时返回原因，否则返回 null */
  exhausted(): string | null {
    const { steps, tokens, minutes } = this.limits;
    if (this.steps >= steps) return `步数预算耗尽（${this.steps}/${steps}）`;
    if (this.tokens >= tokens) return `token 预算耗尽（${this.tokens}/${tokens}）`;
    if (this.now() - this.startedAt >= minutes * 60_000) return `时长预算耗尽（${minutes} 分钟）`;
    return null;
  }

  /** 剩余时长（毫秒），不会为负 */
  remainingMs(): number {
    return Math.max(0, this.limits.minutes * 60_000 - (this.now() - this.startedAt));
  }

  /**
   * 单次调用结束后的超额检查：token 已用超过上限，或已用时长超过上限（不检查步数，
   * 步数只在每轮开始时用 exhausted() 检查）。风格与 exhausted() 一致，用于单次调用
   * 一次性超出预算的场景（例如一轮就吃掉全部 token 预算）。
   */
  overrun(): string | null {
    const { tokens, minutes } = this.limits;
    if (this.tokens > tokens) return `token 预算耗尽（${this.tokens}/${tokens}）`;
    if (this.now() - this.startedAt > minutes * 60_000) return `时长预算耗尽（${minutes} 分钟）`;
    return null;
  }

  snapshot(): { steps: number; tokens: number; elapsedMs: number } {
    return { steps: this.steps, tokens: this.tokens, elapsedMs: this.now() - this.startedAt };
  }
}
