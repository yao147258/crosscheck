import type { BudgetLimits } from '../schema/config';

/** 单个用例的步数 / token / 时长预算 */
export class BudgetTracker {
  private steps = 0;
  private tokens = 0;
  private readonly startedAt: number;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now,
    /** 子账本的父账本：记录同时计入，父耗尽时子同样耗尽 */
    private readonly parent?: BudgetTracker,
  ) {
    this.startedAt = now();
  }

  recordStep(): void {
    this.steps++;
    this.parent?.recordStep();
  }

  recordTokens(n: number): void {
    this.tokens += n;
    this.parent?.recordTokens(n);
  }

  /** 已耗尽时返回原因，否则返回 null */
  exhausted(): string | null {
    const { steps, tokens, minutes } = this.limits;
    if (this.steps >= steps) return `步数预算耗尽（${this.steps}/${steps}）`;
    if (this.tokens >= tokens) return `token 预算耗尽（${this.tokens}/${tokens}）`;
    if (this.now() - this.startedAt >= minutes * 60_000) return `时长预算耗尽（${minutes} 分钟）`;
    return this.parent?.exhausted() ?? null;
  }

  /** 剩余时长（毫秒），不会为负；取整避免 AbortSignal.timeout 等 API 要求整数而偶发崩溃 */
  remainingMs(): number {
    const own = Math.max(0, Math.round(this.limits.minutes * 60_000 - (this.now() - this.startedAt)));
    return this.parent ? Math.min(own, this.parent.remainingMs()) : own;
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
    return this.parent?.overrun() ?? null;
  }

  /** 剩余步数、token、时长，均不为负；子账本同时受父账本约束。 */
  remaining(): { steps: number; tokens: number; ms: number } {
    const own = { steps: Math.max(0, this.limits.steps - this.steps), tokens: Math.max(0, this.limits.tokens - this.tokens), ms: this.remainingMs() };
    if (!this.parent) return own;
    const up = this.parent.remaining();
    return { steps: Math.min(own.steps, up.steps), tokens: Math.min(own.tokens, up.tokens), ms: own.ms };
  }

  /** 派生子账本：上限取 cap 与剩余额度×share 的较小值，保证父代理留有收尾额度。 */
  child(cap: Partial<BudgetLimits> = {}, share = 0.5): BudgetTracker {
    if (!(share > 0 && share <= 1)) throw new Error('子预算比例必须在 (0, 1] 内');
    const r = this.remaining();
    const limits: BudgetLimits = {
      steps: Math.max(1, Math.min(cap.steps ?? Infinity, Math.floor(r.steps * share))),
      tokens: Math.max(1, Math.min(cap.tokens ?? Infinity, Math.floor(r.tokens * share))),
      minutes: Math.min(cap.minutes ?? Infinity, (r.ms * share) / 60_000),
    };
    return new BudgetTracker(limits, this.now, this);
  }

  snapshot(): { steps: number; tokens: number; elapsedMs: number } {
    return { steps: this.steps, tokens: this.tokens, elapsedMs: this.now() - this.startedAt };
  }
}
