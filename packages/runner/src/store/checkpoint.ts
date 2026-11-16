import { createHash } from 'node:crypto';
import { ArtifactError, ArtifactStore, CaseResultSchema, EvidenceRecordSchema, TraceEventSchema, evidencePath, type CaseResult, type EvidenceRecord, type TraceEvent } from '@crosscheck/core';
export { evidencePath } from '@crosscheck/core';

export async function validateCheckpoint(store: ArtifactStore, result: CaseResult, trace: TraceEvent[], evidence: EvidenceRecord[], prefix: string): Promise<void> {
  if (!CaseResultSchema.safeParse(result).success) throw new ArtifactError('用例结果不合法');
  for (const entry of [...trace, ...evidence]) {
    if (entry.runId !== result.runId || entry.caseId !== result.caseId || entry.attempt !== result.attempt) throw new ArtifactError('提交点归属不一致');
  }
  for (const entry of trace) if (!TraceEventSchema.safeParse(entry).success) throw new ArtifactError('轨迹不合法');
  const ids = new Set(evidence.map(entry => entry.id));
  if (ids.size !== evidence.length) throw new ArtifactError('证据标识重复');
  const references = [
    ...result.expectations.flatMap(item => [item.executor, item.reviewer].flatMap(judgement => judgement?.evidenceIds ?? [])),
    ...trace.flatMap(event => [...event.beforeEvidenceIds, ...event.afterEvidenceIds]),
  ];
  if (references.some(id => !ids.has(id))) throw new ArtifactError('判定或轨迹引用了不存在的证据');
  for (const entry of evidence) {
    if (!EvidenceRecordSchema.safeParse(entry).success || !entry.redacted || entry.path !== evidencePath(prefix, entry.id, entry.mime)) throw new ArtifactError('证据归属或路径不合法');
    const bytes = await store.readBytes(entry.path);
    if (!bytes || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== entry.digest) throw new ArtifactError('证据文件缺失或摘要不匹配');
  }
}
