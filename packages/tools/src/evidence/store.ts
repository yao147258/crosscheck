import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { ArtifactError, ArtifactStore, CaseIdSchema, RuntimeIdSchema, EvidenceRecordSchema, evidencePath, type EvidenceRecord, type TraceEvent } from '@crosscheck/core';
import type { EvidenceRedactor } from './redactor';
import { sanitizeHar } from './sanitize-har';
import { sanitizeDom, type DomNode } from './sanitize-dom';
import { readTrustedCapture } from '../browser/capture';

/** 载荷真实存在且验证通过，但响应本身不能提供完整 JSON 变量。 */
export class HttpResponseUnavailableError extends Error {
  constructor() { super('响应证据没有可用的完整 JSON'); }
}

type Context = { runId: string; caseId: string; attempt: number };
type Meta = { actionId: string; phase: EvidenceRecord['phase'] };

// 同进程共享索引队列；跨进程由宿主在整个运行期间持有 RunStore 锁。
const queues = new Map<string, Promise<void>>();

/** 同一进程按根目录和 attempt 串行登记；跨进程调用方须在采集至提交的整个期间持有 RunStore.withLock。 */
export class EvidenceStore {
  private readonly prefix: string;
  /** 动态command身份解析前只发布固定省略信封，绝不写入未知载荷或临时原文。 */
  private payloadsOmitted: boolean;
  constructor(private readonly artifacts: ArtifactStore, private readonly context: Context, private readonly redactor: EvidenceRedactor, options: { omitPayloadsUntilAuthenticated?: boolean } = {}) {
    this.payloadsOmitted = options.omitPayloadsUntilAuthenticated === true;
    if (!RuntimeIdSchema.safeParse(context.runId).success || !CaseIdSchema.safeParse(context.caseId).success || !Number.isSafeInteger(context.attempt) || context.attempt < 1) throw new ArtifactError('证据归属不合法');
    this.context = { ...context };
    this.prefix = `runs/${context.runId}/cases/${context.caseId}/attempts/${context.attempt}`;
  }
  /** 仅宿主在认证成功且全部动态凭证已登记后调用，不回写先前省略记录。 */
  allowAuthenticatedPayloads(): void { this.payloadsOmitted = false; }
  get omittingPayloads(): boolean { return this.payloadsOmitted; }
  private async save(type: EvidenceRecord['type'], mime: string, content: string | Buffer, meta: Meta): Promise<EvidenceRecord> {
    if (this.payloadsOmitted) {
      if (type === 'network') content = JSON.stringify(sanitizeHar({ log: { entries: [{ request: { method: 'OMITTED', url: 'about:blank' }, response: { status: 0, content: { mimeType: 'text/plain', omitted: true } }, failure: { kind: 'omitted', message: '动态身份认证前载荷已省略，不能作为完整观察' } }] } }, this.redactor));
      else if (type === 'console') content = '[omitted: unauthenticated payload]';
      else throw new ArtifactError('动态身份认证前不允许此类载荷');
    }
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
    try { return await task; }
    finally { if (queues.get(queueKey) === settled) queues.delete(queueKey); }
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
  /** 仅宿主夹具使用：限定当前 attempt 已登记的网络证据，不接受路径。 */
  async readHttpResponse(id: string): Promise<{ status: number; body: unknown }> {
    const index = await this.artifacts.readJson(`${this.prefix}/evidence/index.json`, EvidenceRecordSchema.array());
    const matches = index?.filter(record => record.id === id) ?? [];
    if (matches.length !== 1 || matches[0]!.type !== 'network' || matches[0]!.mime !== 'application/har+json') throw new ArtifactError('响应证据不存在或类型不符');
    const har = JSON.parse((await this.verify(matches[0]!)).toString('utf8'));
    const entries = har?.log?.entries;
    const entry = Array.isArray(entries) && entries.length === 1 ? entries[0] : undefined;
    const response = entry?.response, content = response?.content;
    if (entry?.failure || !content || content.omitted !== false || content.truncated !== false || !/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(content.mimeType) || typeof content.text !== 'string' || !Number.isInteger(response.status)) throw new HttpResponseUnavailableError();
    try { return {status:response.status,body:this.redactor.value(JSON.parse(content.text))}; }
    catch { throw new HttpResponseUnavailableError(); }
  }
  /** 仅宿主 presenter 使用：从当前归属索引按 ID 读取，不接受路径，不返回审计元数据。 */
  async readTextEvidence(id: string): Promise<{ id: string; type: 'network' | 'console' | 'db' | 'dom'; text: string; sourceIncomplete: boolean }> {
    const index = await this.artifacts.readJson(`${this.prefix}/evidence/index.json`, EvidenceRecordSchema.array());
    const matches = index?.filter(record => record.id === id) ?? [];
    const record = matches[0];
    if (matches.length !== 1 || !record || !['network', 'console', 'db', 'dom'].includes(record.type)) throw new ArtifactError('文本证据不存在或类型不符');
    const bytes = await this.verify(record);
    // 密钥可能在落盘后才登记；HAR 内嵌正文须按内容类型解析、清洗再序列化。
    if (record.type === 'console') return { id, type: 'console', text: this.redactor.text(bytes.toString('utf8')), sourceIncomplete: bytes.toString('utf8').includes('[omitted:') };
    const payload: unknown = JSON.parse(bytes.toString('utf8'));
    if (record.type === 'dom') {
      const clean = sanitizeDom(payload as DomNode[], this.redactor);
      const missing = (nodes: DomNode[]): boolean => nodes.some(node => node.omitted === true || node.incomplete === true || !!node.children && missing(node.children));
      return { id, type: 'dom', text: JSON.stringify(clean), sourceIncomplete: missing(clean as DomNode[]) };
    }
    if (record.type === 'network') {
      const har = sanitizeHar(payload, this.redactor);
      // 只读取可信 HAR 正文信封的状态，不递归猜业务 JSON 中同名字段。
      const sourceIncomplete = har.log.entries.some(entry => entry.request.postData?.omitted === true || entry.request.postData?.truncated === true
        || entry.response.content.omitted === true || entry.response.content.truncated === true);
      return { id, type: 'network', text: JSON.stringify(har), sourceIncomplete };
    }
    // 只解释生产DB顶层信封；拒绝/未发送/错误审计不具备业务查询资格，行内status不参与判断。
    const envelope = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    const sourceIncomplete = !envelope || envelope.status !== 'success' || envelope.sent !== true || !Array.isArray(envelope.rows) || envelope.truncated !== false;
    return { id, type: 'db', text: JSON.stringify(this.redactor.value(payload)), sourceIncomplete };
  }
  async saveScreenshot(capture: unknown, meta: Meta): Promise<EvidenceRecord> {
    return this.save('screenshot', 'image/png', readTrustedCapture(capture, this.redactor), meta);
  }
  async readScreenshotEvidence(id: string): Promise<{ id: string; type: 'screenshot'; bytes: Buffer; mediaType: 'image/png' }> {
    const index = await this.artifacts.readJson(`${this.prefix}/evidence/index.json`, EvidenceRecordSchema.array());
    const matches = index?.filter(record => record.id === id) ?? [];
    const record = matches[0];
    if (matches.length !== 1 || !record || record.type !== 'screenshot' || record.mime !== 'image/png') throw new ArtifactError('截图证据不存在或类型不符');
    const bytes = await this.verify(record);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new ArtifactError('截图格式不合法');
    return { id, type: 'screenshot', bytes, mediaType: 'image/png' };
  }
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
