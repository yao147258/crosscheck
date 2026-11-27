import { z } from 'zod';
import type { ArtifactStore } from '../store/artifact-store';
import { contentHash } from './hash';
import type { Clause, TestCase } from '../schema/artifacts';

/** 确认绑定用例与 covers 对应条款内容，不绑定无关条款或数组顺序。 */
export function caseApprovalPayload(tc: TestCase, clauses: Clause[]) {
  const covered = [...new Set(tc.covers)].sort().map((id) => {
    const matches = clauses.filter((clause) => clause.id === id);
    if (matches.length !== 1) throw new Error(`用例 ${tc.id} 的覆盖条款缺失或重复：${id}`);
    return { id, hash: contentHash(matches[0]) };
  });
  return { version: 1 as const, testCase: { ...tc, covers: [...tc.covers].sort() }, clauses: covered };
}

export type ApprovalKind = 'clause' | 'case' | 'profile' | 'notes';
export type ApprovalState = 'approved' | 'stale' | 'none';
export type ApprovalChange = (draft: Approvals, stageArtifactWrite: (kind: ApprovalKind, id: string, write: () => Promise<void>) => void) => void | Promise<void>;

const ApprovalRecordSchema = z.object({ hash: z.string(), by: z.string(), at: z.string() });
type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

function sameRecord(a: ApprovalRecord | undefined, b: ApprovalRecord | undefined): boolean {
  return a?.hash === b?.hash && a?.by === b?.by && a?.at === b?.at;
}

const ApprovalsFileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), ApprovalRecordSchema),
});

const FILE = 'approvals.json';

function key(kind: ApprovalKind, id: string): string {
  return `${kind}:${id}`;
}

/** 工件条目的确认记录：内容哈希不匹配即视为失效 */
export class Approvals {
  private constructor(private readonly entries: Map<string, ApprovalRecord>, private readonly touched?: Set<string>) {}

  /** 在最新表上计算变更，拒绝会话打开后或动作执行期间对同一条目的修改。 */
  async applyChange(store: ArtifactStore, change: ApprovalChange): Promise<Approvals> {
    const baseline = await Approvals.load(store);
    const touched = new Set<string>();
    const draft = new Approvals(new Map(baseline.entries), touched);
    const writes: { id: string; write: () => Promise<void> }[] = [];
    // 回调只准备变更；调用方通过登记函数提交延迟的工件写入。
    await change(draft, (kind, id, write) => { writes.push({ id: key(kind, id), write }); });
    const guarded = new Set([...touched, ...writes.map(({ id }) => id)]);
    const check = (latest: Approvals) => {
      for (const id of guarded) {
        const before = baseline.entries.get(id);
        if (!sameRecord(this.entries.get(id), before) || !sameRecord(before, latest.entries.get(id))) {
          throw new Error(`确认记录 ${id} 已变化，请核对最新状态后重试`);
        }
      }
    };
    let latest = await Approvals.load(store);
    check(latest);
    for (const { write } of writes) {
      await write();
      // 写入与检查不原子；检查失败不会回滚已写工件，但不会覆盖人工确认。
      latest = await Approvals.load(store);
      check(latest);
    }
    for (const id of touched) {
      const after = draft.entries.get(id);
      if (after) latest.entries.set(id, after);
      else latest.entries.delete(id);
    }
    // 仅编辑工件时无需重写审批表；最后一次读取与保存之间没有跨进程 CAS。
    if (touched.size) await latest.save(store);
    return latest;
  }

  static empty(): Approvals {
    return new Approvals(new Map());
  }

  static async load(store: ArtifactStore): Promise<Approvals> {
    const data = await store.readJson(FILE, ApprovalsFileSchema);
    return new Approvals(new Map(Object.entries(data?.entries ?? {})));
  }

  async save(store: ArtifactStore): Promise<void> {
    const sorted = Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
    await store.writeJson(FILE, { version: 1, entries: sorted });
  }

  approve(kind: ApprovalKind, id: string, content: unknown, by: string, at: Date = new Date()): void {
    const entry = key(kind, id);
    this.touched?.add(entry);
    this.entries.set(entry, { hash: contentHash(content), by, at: at.toISOString() });
  }

  approveCase(tc: TestCase, clauses: Clause[], by: string, at: Date = new Date()): void {
    this.approve('case', tc.id, caseApprovalPayload(tc, clauses), by, at);
  }

  stateCase(tc: TestCase, clauses: Clause[]): ApprovalState {
    if (!this.record('case', tc.id)) return 'none';
    try {
      return this.state('case', tc.id, caseApprovalPayload(tc, clauses));
    } catch {
      return 'stale';
    }
  }

  revoke(kind: ApprovalKind, id: string): void {
    const entry = key(kind, id);
    this.touched?.add(entry);
    this.entries.delete(entry);
  }

  record(kind: ApprovalKind, id: string): ApprovalRecord | undefined {
    return this.entries.get(key(kind, id));
  }

  state(kind: ApprovalKind, id: string, content: unknown): ApprovalState {
    const rec = this.entries.get(key(kind, id));
    if (!rec) return 'none';
    return rec.hash === contentHash(content) ? 'approved' : 'stale';
  }
}
