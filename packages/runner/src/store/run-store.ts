import { createHash, randomUUID } from 'node:crypto';
import { ArtifactError, ArtifactStore, CaseIdSchema, CaseResultSchema, EvidenceRecordSchema, RunManifestSchema, RunResultSchema, RuntimeIdSchema, TraceEventSchema, createRedactor, worstStatus, type CaseResult, type EvidenceRecord, type RunManifest, type RunResult, type TraceEvent } from '@crosscheck/core';
import { validateCheckpoint } from './checkpoint';

const RUN_ID = /^\d{8}T\d{9}Z-[a-f0-9]{32}$/;
const encoder = new TextEncoder();
const errno = (err: unknown): string | undefined => (err instanceof Error ? (err.cause as NodeJS.ErrnoException | undefined)?.code : undefined);

export class RunStore {
  private constructor(private readonly artifacts: ArtifactStore, readonly manifest: RunManifest) {}
  private get root(): string { return `runs/${this.manifest.runId}`; }
  private caseRoot(caseId: string): string {
    if (!CaseIdSchema.safeParse(caseId).success || !this.manifest.selectedCaseIds.includes(caseId)) throw new ArtifactError('用例不属于当前运行');
    return `${this.root}/cases/${caseId}/attempts`;
  }
  private attemptRoot(caseId: string, attempt: number): string {
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new ArtifactError('无效的尝试次数');
    return `${this.caseRoot(caseId)}/${attempt}`;
  }
  static async create(artifacts: ArtifactStore, options: Pick<RunManifest, 'fingerprint' | 'environment' | 'selectedCaseIds'>, input: unknown, redactFields: string[] = []): Promise<RunStore> {
    const start = new Date().toISOString();
    const runId = `${start.replace(/[-:.]/g, '')}-${randomUUID().replace(/-/g, '')}`;
    const parsed = RunManifestSchema.safeParse({ version: 1, runId, ...options, status: 'pending', start, end: null });
    if (!parsed.success) throw new ArtifactError('运行清单不合法', { cause: parsed.error });
    const run = new RunStore(artifacts, parsed.data);
    await artifacts.writeJson(`${run.root}/input.json`, createRedactor(redactFields).value(input));
    await artifacts.writeJson(`${run.root}/manifest.json`, run.manifest);
    return run;
  }
  static async load(artifacts: ArtifactStore, runId: string): Promise<RunStore> {
    if (!RuntimeIdSchema.safeParse(runId).success || !RUN_ID.test(runId)) throw new ArtifactError('运行标识不合法');
    const manifest = await artifacts.readJson(`runs/${runId}/manifest.json`, RunManifestSchema);
    if (!manifest || manifest.runId !== runId) throw new ArtifactError('运行清单缺失或归属不一致');
    return new RunStore(artifacts, manifest);
  }
  /** 调用方必须在同一 withLock 生命周期内更新状态。 */
  async updateStatus(status: RunManifest['status']): Promise<void> {
    const manifest = RunManifestSchema.parse({ ...this.manifest, status, end: status === 'completed' || status === 'aborted' ? new Date().toISOString() : null });
    await this.artifacts.writeJson(`${this.root}/manifest.json`, manifest);
    Object.assign(this.manifest, manifest);
  }
  async nextAttempt(caseId: string): Promise<number> {
    const names = await this.artifacts.list(this.caseRoot(caseId));
    const attempts = names.filter(n => /^[1-9]\d*$/.test(n)).map(Number);
    if (attempts.some(n => !Number.isSafeInteger(n)) || Math.max(0, ...attempts) >= Number.MAX_SAFE_INTEGER) throw new ArtifactError('尝试次数超出范围');
    return Math.max(0, ...attempts) + 1;
  }
  async commitCase(result: CaseResult, trace: TraceEvent[], evidence: EvidenceRecord[], signal?: AbortSignal): Promise<CaseResult> {
    const prefix = this.attemptRoot(result.caseId, result.attempt);
    if (result.runId !== this.manifest.runId) throw new ArtifactError('用例运行归属不一致');
    await validateCheckpoint(this.artifacts, result, trace, evidence, prefix);
    if (await this.artifacts.readBytes(`${prefix}/result.json`)) throw new ArtifactError('提交点已经存在');
    await this.artifacts.writeBytes(`${prefix}/trace.jsonl`, Buffer.from(trace.map(event => `${JSON.stringify(event)}\n`).join('')));
    await this.artifacts.writeJson(`${prefix}/evidence/index.json`, evidence);
    return this.artifacts.publishJsonSelected(`${prefix}/result.json`, () => signal?.aborted ? CaseResultSchema.parse({ ...result, complete: false, status: 'BLOCKED', reason: '提交前执行被中断；已发生的业务与证据保留' }) : result);
  }
  private async readTrace(prefix: string): Promise<TraceEvent[] | undefined> {
    const bytes = await this.artifacts.readBytes(`${prefix}/trace.jsonl`);
    if (bytes === undefined) return undefined;
    try {
      const text = bytes.toString('utf8');
      const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
      const values = text === '' ? [] : lines.map(line => JSON.parse(line));
      const parsed = TraceEventSchema.array().safeParse(values);
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    } catch (error) { throw new ArtifactError('轨迹内容不合法', { cause: error }); }
  }
  async listCaseResults(): Promise<CaseResult[]> {
    return (await this.committedResults()).filter(result => result.complete);
  }
  private async committedResults(): Promise<CaseResult[]> {
    const results: CaseResult[] = [];
    for (const caseId of this.manifest.selectedCaseIds) {
      const names = (await this.artifacts.list(this.caseRoot(caseId))).filter(n => /^[1-9]\d*$/.test(n)).map(Number).sort((a, b) => b - a);
      for (const attempt of names) {
        const prefix = this.attemptRoot(caseId, attempt);
        const result = await this.artifacts.readJson(`${prefix}/result.json`, CaseResultSchema);
        if (!result) continue;
        if (result.runId !== this.manifest.runId || result.caseId !== caseId || result.attempt !== attempt) throw new ArtifactError('用例结果目录归属不一致');
        const trace = await this.readTrace(prefix);
        const evidence = await this.artifacts.readJson(`${prefix}/evidence/index.json`, EvidenceRecordSchema.array());
        if (!trace || !evidence) throw new ArtifactError('提交点缺少轨迹或证据索引');
        await validateCheckpoint(this.artifacts, result, trace, evidence, prefix);
        results.push(result);
        break;
      }
    }
    return results;
  }
  async readEvidence(caseId: string, attempt: number, evidenceId: string): Promise<Buffer> {
    const prefix = this.attemptRoot(caseId, attempt);
    const result = await this.artifacts.readJson(`${prefix}/result.json`, CaseResultSchema);
    const trace = await this.readTrace(prefix);
    const evidence = await this.artifacts.readJson(`${prefix}/evidence/index.json`, EvidenceRecordSchema.array());
    if (!result || !trace || !evidence || result.runId !== this.manifest.runId || result.caseId !== caseId || result.attempt !== attempt) throw new ArtifactError('提交点缺失或归属不一致');
    await validateCheckpoint(this.artifacts, result, trace, evidence, prefix);
    const record = evidence.find(item => item.id === evidenceId);
    if (!record) throw new ArtifactError('证据不存在');
    const bytes = await this.artifacts.readBytes(record.path);
    if (!bytes) throw new ArtifactError('证据文件不存在');
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== record.digest) throw new ArtifactError('证据摘要不匹配');
    return bytes;
  }
  /** 只读校验提交点并汇总，供离线报告在发布前核验历史数据。 */
  async readSummary(): Promise<RunResult> {
    const cases = await this.committedResults();
    const known = cases.every(c => c.usage.pricingKnown);
    const parsed = RunResultSchema.safeParse({ version: 1, manifest: this.manifest, cases, status: worstStatus(cases.map(c => c.status)),
      usage: { inputTokens: cases.reduce((n, c) => n + c.usage.inputTokens, 0), outputTokens: cases.reduce((n, c) => n + c.usage.outputTokens, 0), pricingKnown: known, cost: known ? cases.reduce((n, c) => n + (c.usage.cost ?? 0), 0) : null },
      budget: { steps: cases.reduce((n, c) => n + c.budget.used.steps, 0), tokens: cases.reduce((n, c) => n + c.budget.used.tokens, 0), elapsedMs: cases.reduce((n, c) => n + c.budget.used.elapsedMs, 0) } });
    if (!parsed.success) throw new ArtifactError('无法从完整提交点重建运行汇总', { cause: parsed.error });
    return parsed.data;
  }
  async rebuildSummary(): Promise<RunResult> {
    const result = await this.readSummary();
    await this.artifacts.writeJson(`${this.root}/results.json`, result);
    return result;
  }
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = `${this.root}/lock.json`;
    const token = randomUUID();
    const contents = encoder.encode(JSON.stringify({ pid: process.pid, created: new Date().toISOString(), token }));
    const locks = [lock, `${this.root}/lock-recovery.json`, ...[2, 3, 4].map(n => `${this.root}/lock-recovery-${n}.json`)];
    const release = async (rel: string): Promise<void> => {
      const current = await this.artifacts.readBytes(rel);
      if (current?.equals(Buffer.from(contents))) await this.artifacts.remove(rel);
    };
    const acquire = async (level: number): Promise<void> => {
      const target = locks[level]!;
      try { await this.artifacts.publishExclusive(target, contents); return; }
      catch (err) { if (errno(err) !== 'EEXIST') throw err; }
      if (level === locks.length - 1) throw new ArtifactError('恢复锁层数已耗尽，请确认进程状态后人工处理');
      await acquire(level + 1);
      try {
        // 持有上一层后重新读取；只能回收确定不存在的进程。
        const bytes = await this.artifacts.readBytes(target);
        if (bytes) {
          let old: { pid?: unknown; created?: unknown; token?: unknown };
          try { old = JSON.parse(bytes.toString()) as typeof old; } catch { throw new ArtifactError('运行锁损坏，不能自动回收'); }
          if (!old || !Number.isSafeInteger(old.pid) || (old.pid as number) <= 0 || typeof old.created !== 'string' || Number.isNaN(Date.parse(old.created)) || (old.token !== undefined && (typeof old.token !== 'string' || !old.token))) throw new ArtifactError('运行锁不合法，不能自动回收');
          try { process.kill(old.pid as number, 0); throw new ArtifactError('运行已被活进程锁定'); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw new ArtifactError('运行锁进程仍存在或无法确认', { cause: e }); }
          const current = await this.artifacts.readBytes(target);
          if (!current?.equals(bytes)) throw new ArtifactError('运行锁已变化，不能自动回收');
          await this.artifacts.remove(target);
        }
        await this.artifacts.publishExclusive(target, contents);
      } finally { await release(locks[level + 1]!); }
    };
    await acquire(0);
    try { return await fn(); }
    finally { await release(lock); }
  }
}
