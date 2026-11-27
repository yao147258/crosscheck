import { Approvals, type ApprovalChange, type ArtifactStore } from '@crosscheck/core';

export interface ReadonlyReviewContext {
  readonly artifacts: ArtifactStore;
  readonly approvals: Approvals;
}

export class ReviewSession {
  private busy = false;

  private constructor(
    readonly artifacts: ArtifactStore,
    private current: Approvals | undefined,
    readonly reviewer: string,
  ) {}

  static async open(artifacts: ArtifactStore, reviewer: string): Promise<ReviewSession> {
    if (!reviewer.trim()) throw new Error('确认人不能为空');
    return new ReviewSession(artifacts, await Approvals.load(artifacts), reviewer.trim());
  }

  get approvals(): Approvals {
    if (!this.current) throw new Error('确认记录不可用，请重新打开审核会话');
    return this.current;
  }

  /** 同会话不并发修改；失败只重载确认记录，不回滚已经写入的工件。 */
  async mutate(change: ApprovalChange): Promise<void> {
    if (this.busy) throw new Error('审核会话忙碌，请等待当前操作完成');
    const approvals = this.approvals;
    this.busy = true;
    try {
      this.current = await approvals.applyChange(this.artifacts, change);
    } catch (error) {
      this.current = undefined;
      try {
        this.current = await Approvals.load(this.artifacts);
      } catch (reloadError) {
        throw new AggregateError([error, reloadError], '操作失败且无法重载确认记录，请重新打开审核会话');
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
