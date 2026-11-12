import { z } from 'zod';
import type { ArtifactStore } from '../store/artifact-store';
import { contentHash } from './hash';

export type ApprovalKind = 'clause' | 'case' | 'profile';
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
