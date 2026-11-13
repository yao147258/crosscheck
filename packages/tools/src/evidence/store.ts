import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { ArtifactError, ArtifactStore, CaseIdSchema, RuntimeIdSchema, EvidenceRecordSchema, evidencePath, type EvidenceRecord, type TraceEvent } from '@crosscheck/core';
import type { EvidenceRedactor } from './redactor';
import { sanitizeHar } from './sanitize-har';
import { sanitizeDom, type DomNode } from './sanitize-dom';

type Context = { runId: string; caseId: string; attempt: number };
type Meta = { actionId: string; phase: EvidenceRecord['phase'] };

// 同进程共享索引队列；跨进程由宿主在整个运行期间持有 RunStore 锁。
const queues = new Map<string, Promise<void>>();

/** 截图生产者须在 Task5 证明所有敏感区域已遮蔽，当前不提供截图登记。 */
export interface SafeCaptureProtocol { readonly kind: 'masked-capture'; readonly complete: true; }

/** 同一进程按根目录和 attempt 串行登记；跨进程调用方须在采集至提交的整个期间持有 RunStore.withLock。 */
export class EvidenceStore {
  private readonly prefix: string;
  constructor(private readonly artifacts: ArtifactStore, private readonly context: Context, private readonly redactor: EvidenceRedactor) {
    if (!RuntimeIdSchema.safeParse(context.runId).success || !CaseIdSchema.safeParse(context.caseId).success || !Number.isSafeInteger(context.attempt) || context.attempt < 1) throw new ArtifactError('证据归属不合法');
    this.context = { ...context };
    this.prefix = `runs/${context.runId}/cases/${context.caseId}/attempts/${context.attempt}`;
  }
  private async save(type: EvidenceRecord['type'], mime: string, content: string, meta: Meta): Promise<EvidenceRecord> {
    const parent = await realpath(path.dirname(this.artifacts.root));
    const key = path.resolve(parent, '.crosscheck', this.prefix);
    const queueKey = process.platform === 'win32' ? key.toLowerCase() : key;
    const task = (queues.get(queueKey) ?? Promise.resolve()).then(async () => {
      const id = `e-${randomUUID()}`;
      const path = evidencePath(this.prefix, id, mime);
      const bytes = Buffer.from(content);
      const record = EvidenceRecordSchema.parse({ id, type, ...this.context, ...meta, time: new Date().toISOString(), mime, path, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, redacted: true });
      const index = await this.artifacts.readJson(`${this.prefix}/evidence/index.json`, EvidenceRecordSchema.array()) ?? [];
      await this.artifacts.publishExclusive(path, bytes);
      await this.artifacts.writeJson(`${this.prefix}/evidence/index.json`, [...index, record]);
      return record;
    });
    const settled = task.then(() => {}, () => {});
    queues.set(queueKey, settled);
    void settled.then(() => { if (queues.get(queueKey) === settled) queues.delete(queueKey); });
    return task;
  }
  async saveText(type: 'console' | 'db', text: string, meta: Meta): Promise<EvidenceRecord> {
    if (type === 'db') {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new ArtifactError('数据库证据必须是有效 JSON'); }
      return this.saveJson('db', parsed, meta);
    }
    return this.save(type, 'text/plain', this.redactor.text(text), meta);
  }
  async saveJson(type: 'db', value: unknown, meta: Meta): Promise<EvidenceRecord> {
    let json: string;
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error();
      json = JSON.stringify(this.redactor.value(JSON.parse(serialized)));
    } catch { throw new ArtifactError('数据库证据必须可序列化为 JSON'); }
    return this.save(type, 'application/json', json, meta);
  }
  saveHar(har: unknown, meta: Meta): Promise<EvidenceRecord> { return this.save('network', 'application/har+json', JSON.stringify(sanitizeHar(har, this.redactor)), meta); }
  saveDom(nodes: DomNode[], meta: Meta): Promise<EvidenceRecord> { return this.save('dom', 'application/json', JSON.stringify(sanitizeDom(nodes, this.redactor)), meta); }
  async saveScreenshot(_capture: unknown, _meta: Meta): Promise<never> { throw new ArtifactError('截图遮蔽尚未由可信采集器实现'); }
  sanitizeTrace(event: TraceEvent): TraceEvent { return this.redactor.trace(event); }
  async verify(record: EvidenceRecord): Promise<Buffer> {
    if (!EvidenceRecordSchema.safeParse(record).success || !record.redacted || record.runId !== this.context.runId || record.caseId !== this.context.caseId || record.attempt !== this.context.attempt || record.path !== evidencePath(this.prefix, record.id, record.mime)) throw new ArtifactError('证据归属或路径不合法');
    const index = await this.artifacts.readJson(`${this.prefix}/evidence/index.json`, EvidenceRecordSchema.array());
    if (!index || index.filter(item => item.id === record.id).length !== 1 || !index.some(item => JSON.stringify(item) === JSON.stringify(record))) throw new ArtifactError('证据未登记或记录不匹配');
    const bytes = await this.artifacts.readBytes(record.path);
    if (!bytes || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== record.digest) throw new ArtifactError('证据缺失或摘要不匹配');
    return bytes;
  }
}
