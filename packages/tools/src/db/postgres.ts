import pg from 'pg';
import { isIP, Socket } from 'node:net';
import { z } from 'zod';
import { checkReadonlySql, DataModelSchema, type EvidenceRecord } from '@crosscheck/core';
import type { EvidenceStore } from '../evidence/store';
import type { EvidenceRedactor } from '../evidence/redactor';

export type DbMeta = { actionId: string; phase: EvidenceRecord['phase'] };
export const DbInputSchema = z.strictObject({ name: z.string().min(1).optional(), sql: z.string().min(1).optional(), params: z.array(z.json()).optional() }).refine(value => (value.name === undefined) !== (value.sql === undefined), '必须且只能提供具名查询或 SELECT');
export type DbInput = { name?: string; sql?: string; params?: z.infer<typeof z.json>[] };
export type DbErrorKind = 'blocked' | 'cancelled' | 'timeout' | 'database';
export class DbOperationError extends Error {
  constructor(readonly kind: DbErrorKind, message: string, readonly evidenceIds: string[]) { super(message); this.name = 'DbOperationError'; }
}
export interface DbResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
  notice: string;
  evidenceIds: string[];
}
export interface PgConnection {
  connect(): Promise<void>;
  run(text: string, values: unknown[], row: (value: Record<string, unknown>) => void): Promise<void>;
  close(): Promise<void>;
}

// 只消费完整 TCP URL，不把 URL 交 pg 二次解析，避免 query 覆盖目标或隐式读取证书文件。
function parseConnectionUrl(connectionString: string): pg.ClientConfig & { replication: string } {
  try {
    if (!/^postgres(?:ql)?:\/\//.test(connectionString) || /[\s\\\u0000-\u001f\u007f]/.test(connectionString) || connectionString.includes('#')) throw new Error();
    const url = new URL(connectionString);
    const host = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
    if (!host || (!isIP(host) && !/^[a-zA-Z0-9_.-]+$/.test(host))) throw new Error();
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    if ([user, password, database].some(value => !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) || !url.pathname.startsWith('/') || url.pathname.slice(1).includes('/')) throw new Error();
    const port = url.port ? Number(url.port) : 5432;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    const entries = [...url.searchParams.entries()];
    if (entries.length > 1 || entries.some(([key, value]) => key !== 'sslmode' || !['verify-full', 'disable'].includes(value))) throw new Error();
    return {
      host, user, password, database, port,
      ssl: url.searchParams.get('sslmode') === 'disable' ? false : { rejectUnauthorized: true },
      // pg@8.23.1 val() 会对 falsy 值读取环境：空 options/false replication 不能隔离。
      // 空白 options 是无命令参数；字符串 false 是服务端接受的禁用复制值。
      options: ' ', replication: 'false', application_name: 'crosscheck', fallback_application_name: 'crosscheck',
      client_encoding: 'UTF8', sslnegotiation: 'postgres',
    };
  } catch { throw new Error('数据库连接必须是完整 TCP URL，仅支持显式账号、非空密码、数据库及 verify-full/disable SSL 模式'); }
}

/** 宿主准备适配器复用同一严格 URL 准入；不向模型暴露连接值。 */
export function postgresConnectionIdentity(connectionString: string): { host: string; port: number; user: string; database: string } {
  const config = parseConnectionUrl(connectionString);
  return { host: config.host!.toLowerCase(), port: config.port!, user: config.user!, database: config.database! };
}

// 使用公开的 stream 工厂保留专属 socket，取消时不依赖 query_timeout 或 pg 私有字段。
export function createPgConnection(connectionString: string): PgConnection {
  const config = parseConnectionUrl(connectionString);
  const socket = new Socket();
  const client = new pg.Client({ ...config, stream: () => socket, connectionTimeoutMillis: 5_000, statement_timeout: 10_000, lock_timeout: 2_000, pipeline: false });
  client.on('error', () => {});
  let closed = false;
  return {
    async connect() { await client.connect(); },
    run(text, values, row) {
      return new Promise<void>((resolve, reject) => {
        const config: pg.QueryConfig & { queryMode: 'extended' } = { text, values, queryMode: 'extended' };
        const query = new pg.Query(config);
        query.on('row', row);
        query.once('error', reject);
        query.once('end', () => resolve());
        client.query(query);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      socket.destroy();
      await client.end();
    },
  };
}

interface ReaderOptions {
  env?: Record<string, string | undefined>;
  createConnection?: (connectionString: string) => PgConnection;
  maxRows?: number;
  maxBytes?: number;
}
const ROLE_CHECK = `SELECT EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'MEMBER') AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)) AS privileged`;
const messages: Record<DbErrorKind, string> = { blocked: '只读查询未通过验证或账号权限不符合要求', cancelled: '数据库查询已取消', timeout: '数据库查询超时', database: '数据库连接或查询失败' };

export class PostgresReader {
  private readonly profile: z.infer<typeof DataModelSchema>;
  private readonly maxRows: number;
  private readonly maxBytes: number;
  constructor(profile: z.infer<typeof DataModelSchema>, private readonly store: EvidenceStore, private readonly redactor: EvidenceRedactor, private readonly options: ReaderOptions = {}) {
    this.profile = DataModelSchema.parse(profile);
    for (const limit of [options.maxRows, options.maxBytes]) if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('数据库结果上限必须是正安全整数');
    this.maxRows = Math.min(options.maxRows ?? 1000, 1000);
    this.maxBytes = Math.min(options.maxBytes ?? 1024 * 1024, 1024 * 1024);
  }
  async query(input: DbInput, meta: DbMeta, signal: AbortSignal): Promise<DbResult> {
    const parsed = DbInputSchema.safeParse(input);
    let sql: string | undefined;
    let params: unknown[] = [];
    let valid = parsed.success;
    if (parsed.success) {
      params = parsed.data.params ?? [];
      if (parsed.data.name !== undefined) {
        const query = Object.hasOwn(this.profile.queries, parsed.data.name) ? this.profile.queries[parsed.data.name] : undefined;
        sql = query?.sql;
        valid = !!query && query.parameters.length === params.length && query.parameters.every((p, i) => params[i] === null ? p.nullable : p.type === 'json' || typeof params[i] === p.type);
        // nullable 的 JS null 表示 SQL NULL；仅具名 json 的非 null 值做 JSON 编码。
        if (valid) params = params.map((value, i) => query!.parameters[i]!.type === 'json' && value !== null ? JSON.stringify(value) : value);
      } else sql = parsed.data.sql;
      valid = valid && sql !== undefined && checkReadonlySql(sql, { parameterCount: params.length }).ok;
    }
    const connectionString = this.profile.connection && (this.options.env ?? process.env)[this.profile.connection.env];
    try { if (!connectionString) valid = false; else parseConnectionUrl(connectionString); } catch { valid = false; }
    if (signal.aborted || !valid || !connectionString) {
      const kind = signal.aborted ? 'cancelled' : 'blocked';
      const record = await this.store.saveJson('db', { status: kind, sent: false, message: messages[kind] }, meta);
      throw new DbOperationError(kind, messages[kind], [record.id]);
    }
    let client: PgConnection | undefined;
    let closing: Promise<void> | undefined;
    let kind: DbErrorKind | undefined;
    let sent = false;
    let truncated = false;
    let bytes = 2;
    const rows: Record<string, unknown>[] = [];
    const close = () => closing ??= client?.close() ?? Promise.resolve();
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    const interrupt = (reason: DbErrorKind) => { kind = reason; stop(); };
    const abort = () => interrupt('cancelled');
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => interrupt('timeout'), 15_000);
    const execute = async () => {
      client = (this.options.createConnection ?? createPgConnection)(connectionString);
      await client.connect();
      if (kind) return;
      await client.run('BEGIN READ ONLY', [], () => {});
      if (kind) return;
      await client.run("SET LOCAL statement_timeout = '10000ms'", [], () => {});
      if (kind) return;
      await client.run("SET LOCAL lock_timeout = '2000ms'", [], () => {});
      if (kind) return;
      let safeRole = false;
      await client.run(ROLE_CHECK, [], row => { safeRole = row.privileged === false; });
      if (kind) return;
      if (!safeRole) { kind = 'blocked'; return; }
      sent = true;
      await client.run(sql!, params, value => {
        if (kind || truncated) return;
        try {
          const clean = this.redactor.value(JSON.parse(JSON.stringify(value))) as Record<string, unknown>;
          const size = Buffer.byteLength(JSON.stringify(clean)) + (rows.length ? 1 : 0);
          if (rows.length >= this.maxRows || bytes + size > this.maxBytes) { truncated = true; stop(); return; }
          rows.push(clean); bytes += size;
        } catch { interrupt('database'); }
      });
      if (!kind && !truncated) await client.run('ROLLBACK', [], () => {});
    };
    try {
      if (signal.aborted) kind = 'cancelled';
      else await Promise.race([execute(), stopped]);
    } catch (error) {
      if (!kind) kind = error && typeof error === 'object' && 'code' in error && ['57014', '55P03'].includes(String(error.code)) ? 'timeout' : 'database';
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([close(), new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('数据库连接清理超时')), 2_000); })]);
      } finally { clearTimeout(cleanupTimer); }
    }
    if (signal.aborted) kind = 'cancelled';
    if (kind) {
      const record = await this.store.saveJson('db', { status: kind, sent, message: messages[kind] }, meta);
      throw new DbOperationError(kind, messages[kind], [record.id]);
    }
    const notice = truncated ? '查询结果已截断，不能用于完整集合结论' : '';
    const record = await this.store.saveJson('db', { status: 'success', sent, rows, truncated, notice }, meta);
    return { rows, truncated, notice, evidenceIds: [record.id] };
  }
}
