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

const ApprovalRecordSchema = z.object({ hash: z.string(), by: z.string(), at: z.string() });
type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

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
  private constructor(private readonly entries: Map<string, ApprovalRecord>) {}

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
    this.entries.set(key(kind, id), { hash: contentHash(content), by, at: at.toISOString() });
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
    this.entries.delete(key(kind, id));
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
