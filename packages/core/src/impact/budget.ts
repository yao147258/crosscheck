// 两侧快照、所有根因共用预算；不得为每个遍历重置。
export class ImpactLimit extends Error {}
export class ImpactBudget {
  limited = false;
  private work = 0;
  private output = 0;
  private reasons = 0;
  spend(amount = 1): void {
    if ((this.work += amount) > 100000) this.fail();
  }
  emit(value: unknown): void {
    if ((this.output += JSON.stringify(value).length) > 1000000) this.fail();
  }
  reason(): void { if (++this.reasons > 10000) this.fail(); }
  fail(): never { this.limited = true; throw new ImpactLimit(); }
}
