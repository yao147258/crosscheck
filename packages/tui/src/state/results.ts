import {
  Approvals, DispositionSchema, DispositionsFileSchema, moduleOfId, upsertDisposition,
  type ArtifactStore, type Decision, type Disposition, type DispositionsFile, type EvidenceRecord, type Judgement,
} from '@crosscheck/core';
import { loadReportData, type ReportData } from '@crosscheck/report';
import { RunStore } from '@crosscheck/runner';
import type { ReviewSession } from '../io/session';
import { markClauseUnclear } from './clauses';

export const DECISION_LABELS: Record<Decision, string> = {
  confirmed_bug: '确认是 bug', false_positive: '误报', clause_issue: '条款有问题',
};

const RUN_ID = /^\d{8}T\d{9}Z-[a-f0-9]{32}$/;
export async function listRuns(session: ReviewSession): Promise<string[]> {
  return (await session.artifacts.list('runs')).filter((name) => RUN_ID.test(name)).sort().reverse();
}

export interface ResultRow {
  caseId: string;
  attempt: number;
  expectationId: string;
  expectationText: string;
  status: 'FAIL' | 'DISPUTED';
  executor: Judgement | null;
  reviewer: Judgement | null;
  covers: string[];
  evidence: EvidenceRecord[];
  disposition?: Disposition;
}

async function readDispositions(artifacts: ArtifactStore, runId: string): Promise<DispositionsFile> {
  const file = await artifacts.readJson(`runs/${runId}/dispositions.json`, DispositionsFileSchema);
  if (file && file.runId !== runId) throw new Error('裁决文件运行归属不一致');
  return file ?? { version: 1, runId, items: [] };
}

function resultRows(data: ReportData, dispositions: DispositionsFile): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const result of data.result.cases) {
    const testCase = data.display.cases.find((tc) => tc.id === result.caseId)!;
    for (const e of result.expectations) {
      if (e.status !== 'FAIL' && e.status !== 'DISPUTED') continue;
      rows.push({
        caseId: result.caseId, attempt: result.attempt, expectationId: e.expectationId,
        expectationText: testCase.expectations.find((x) => x.id === e.expectationId)!.text,
        status: e.status, executor: e.executor, reviewer: e.reviewer, covers: testCase.covers,
        evidence: (data.evidence.get(result.caseId) ?? []).map((item) => item.record),
        disposition: dispositions.items.find((d) => d.caseId === result.caseId && d.expectationId === e.expectationId),
      });
    }
  }
  return rows;
}

/** 与运行恢复互斥，使用报告的完整历史快照及证据校验链。 */
export async function loadResultRows(session: ReviewSession, runId: string): Promise<ResultRow[]> {
  const run = await RunStore.load(session.artifacts, runId);
  return run.withLock(async () => {
    const current = await RunStore.load(session.artifacts, runId);
    return resultRows(await loadReportData(session.artifacts, current), await readDispositions(session.artifacts, runId));
  });
}

/** 这里只映射白名单；实际导出还必须验证可信索引中的证据类型。 */
export function extensionFor(mime: string): string {
  const normalized = mime.split(';')[0]!.trim().toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'application/json' || normalized === 'application/har+json') return 'json';
  return 'txt';
}

/** 不使用调用方传入的 MIME、路径或摘要；仅导出校验后的历史证据原字节。 */
export async function exportEvidence(session: ReviewSession, runId: string, row: Pick<ResultRow, 'caseId' | 'attempt' | 'evidence'>, evidenceId: string): Promise<string> {
  if (!row.evidence.some((e) => e.id === evidenceId)) throw new Error('证据不存在');
  const run = await RunStore.load(session.artifacts, runId);
  return run.withLock(async () => {
    const current = await RunStore.load(session.artifacts, runId);
    const data = await loadReportData(session.artifacts, current);
    const result = data.result.cases.find((c) => c.caseId === row.caseId && c.attempt === row.attempt);
    const item = result && data.evidence.get(row.caseId)?.find((e) => e.record.id === evidenceId);
    if (!item) throw new Error('证据不存在或不属于所选历史结果');
    let extension = extensionFor(item.record.mime);
    // 当前采集器尚未实现可信遮蔽截图协议，不能仅凭 MIME/type 声明用图片程序打开。
    if (extension === 'png' || extension === 'jpg') extension = 'txt';
    const rel = `.open/${item.record.id}.${extension}`;
    await session.artifacts.writeBytes(rel, item.bytes);
    return session.artifacts.resolve(rel);
  });
}

export interface DispositionInput { caseId: string; expectationId: string; decision: Decision; clauseId?: string; note: string }

/** 跨文件不原子；失败后重新读取磁盘，明确区分条款、确认和裁决的实际状态。 */
async function dispositionFailure(session: ReviewSession, runId: string, item: Disposition, error: unknown): Promise<Error> {
  const states: string[] = [];
  try {
    const file = await readDispositions(session.artifacts, runId);
    const saved = file.items.find((d) => d.caseId === item.caseId && d.expectationId === item.expectationId);
    states.push(`磁盘裁决：${saved ? `${DECISION_LABELS[saved.decision]}（${saved.at}）` : '未记录'}`);
  } catch { states.push('磁盘裁决：无法核实'); }
  if (item.clauseId) {
    try {
      const clause = (await session.artifacts.loadClauses(moduleOfId(item.clauseId))).find((c) => c.id === item.clauseId);
      states.push(`条款 ${item.clauseId}：${clause?.status ?? '不存在'}`);
    } catch { states.push('条款：无法核实'); }
    try {
      states.push(`条款确认：${(await Approvals.load(session.artifacts)).record('clause', item.clauseId) ? '仍有记录' : '已撤销或无记录'}`);
    } catch { states.push('条款确认：无法核实'); }
  }
  try {
    states.push(`运行锁：${await session.artifacts.readBytes(`runs/${runId}/lock.json`) ? '仍存在，需核实持有者' : '已释放'}`);
  } catch { states.push('运行锁：无法核实'); }
  return new Error(`处置流程未完成或部分完成；${states.join('；')}。原因：${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

export async function recordDisposition(session: ReviewSession, runId: string, input: DispositionInput, now: Date = new Date()): Promise<string> {
  const item = DispositionSchema.parse({ ...input, by: session.reviewer, at: now.toISOString() });
  const run = await RunStore.load(session.artifacts, runId);
  // 一致锁序：运行锁 → 会话 mutate。不得在 mutate 内调用另一个 mutate。
  try {
    await run.withLock(async () => {
      const current = await RunStore.load(session.artifacts, runId);
      const data = await loadReportData(session.artifacts, current);
      const file = await readDispositions(session.artifacts, runId);
      const row = resultRows(data, file).find((r) => r.caseId === item.caseId && r.expectationId === item.expectationId);
      if (!row) throw new Error('只能裁决该历史运行内的 FAIL/DISPUTED 预期');
      if (item.clauseId && !row.covers.includes(item.clauseId)) throw new Error('裁决条款不在该历史用例 covers 内');
      if (item.clauseId) {
        const historical = data.display.clauses.find((c) => c.id === item.clauseId)!;
        await markClauseUnclear(session, moduleOfId(item.clauseId), item.clauseId, historical);
      }
      // 条款和确认变更成功后才发布裁决；失败不伪造回滚或成功。
      await session.artifacts.writeJson(`runs/${runId}/dispositions.json`, upsertDisposition(file, item));
    });
  } catch (error) { throw await dispositionFailure(session, runId, item, error); }
  return item.clauseId
    ? `已记录：${DECISION_LABELS[item.decision]}，${item.clauseId} 已标记为 unclear 并撤销确认`
    : `已记录：${DECISION_LABELS[item.decision]}`;
}
