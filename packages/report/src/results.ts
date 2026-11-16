import { z } from 'zod';
import { ArtifactError, contentHash, DigestSchema, EvidenceRecordSchema, ModuleCasesSchema, ModuleClausesSchema, RunResultSchema, type ArtifactStore, type EvidenceRecord, type RunResult } from '@crosscheck/core';
import { RunStore } from '@crosscheck/runner';

// 展示投影不是可执行输入，只解析报告必需的历史字段，不读取当前项目画像。
const SnapshotSchema = z.strictObject({ version: z.literal(1), policy: z.literal('plan2-task9-http-db-v1'), sourceFingerprint: DigestSchema, fingerprint: DigestSchema, displayDigest: DigestSchema, display: z.unknown() });
const DisplaySchema = z.object({ clauses: ModuleClausesSchema, cases: ModuleCasesSchema });
export interface ReportEvidence { record: EvidenceRecord; bytes: Buffer }
export interface ReportData { result: RunResult; display: z.infer<typeof DisplaySchema>; evidence: Map<string, ReportEvidence[]> }
export async function loadReportData(artifacts: ArtifactStore, run: RunStore): Promise<ReportData> {
  const root = `runs/${run.manifest.runId}`;
  const saved = await artifacts.readJson(`${root}/input.json`, SnapshotSchema);
  if (!saved || saved.fingerprint !== run.manifest.fingerprint || contentHash(saved.display) !== saved.displayDigest) throw new ArtifactError('历史展示快照缺失或摘要不匹配');
  const display = DisplaySchema.parse(saved.display);
  const result = await run.readSummary();
  const previous = await artifacts.readJson(`${root}/results.json`, RunResultSchema);
  if (previous && contentHash(previous) !== contentHash(result)) throw new ArtifactError('保存的运行汇总与提交点不一致');
  if (display.cases.length !== result.cases.length || new Set(display.cases.map(tc => tc.id)).size !== display.cases.length || result.cases.some(c => !display.cases.some(tc => tc.id === c.caseId))) throw new ArtifactError('历史展示用例与选中结果不一致');
  const evidence = new Map<string, ReportEvidence[]>();
  for (const c of result.cases) {
    const tc = display.cases.find(tc => tc.id === c.caseId)!;
    if (tc.covers.some(id => !display.clauses.some(clause => clause.id === id)) || c.expectations.some(e => !tc.expectations.some(expected => expected.id === e.expectationId)) || c.complete && c.expectations.length !== tc.expectations.length) throw new ArtifactError('历史条款、预期与结果不一致');
    const records = await artifacts.readJson(`${root}/cases/${c.caseId}/attempts/${c.attempt}/evidence/index.json`, EvidenceRecordSchema.array());
    if (!records) throw new ArtifactError('证据索引缺失');
    const items: ReportEvidence[] = [];
    for (const record of records) items.push({ record, bytes: await run.readEvidence(c.caseId, c.attempt, record.id) });
    evidence.set(c.caseId, items.sort((a, b) => a.record.time.localeCompare(b.record.time)));
  }
  return { result, display, evidence };
}
