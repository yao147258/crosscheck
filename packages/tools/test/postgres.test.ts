import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, DataModelSchema } from '../../core/src/index';
import { createEvidenceRedactor, EvidenceStore } from '../src/index';
import { PostgresReader, type PgConnection } from '../src/db/postgres';
import { createDbTools } from '../src/db/tools';

const roots: string[] = [];
const meta = { actionId: 'a-db', phase: 'execution' as const };
const signal = () => new AbortController().signal;
class FakeConnection implements PgConnection {
  calls: { text: string; values: unknown[] }[] = [];
  closed = false;
  connected = false;
  privileged = false;
  failure?: Error;
  pending?: () => void;
  rows: Record<string, unknown>[] = [{ id: 1, password: 'unknown-password', nested: { accessToken: 'unknown-token' } }];
  async connect() { this.connected = true; }
  async run(text: string, values: unknown[], row: (value: Record<string, unknown>) => void) {
    this.calls.push({ text, values });
    if (text.includes('pg_roles')) { row({ privileged: this.privileged }); return; }
    if (!text.startsWith('SELECT')) return;
    if (this.failure) throw this.failure;
    if (this.pending) { await new Promise<void>((_, reject) => { this.pending = () => reject(new Error('connection closed')); }); return; }
    for (const value of this.rows) row(value);
  }
  async close() { this.closed = true; this.pending?.(); }
}
async function setup(options: { maxRows?: number; maxBytes?: number; url?: string; queries?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'db-tools-')); roots.push(root);
  const artifacts = new ArtifactStore(root);
  const redactor = createEvidenceRedactor([], ['known-secret']);
  const store = new EvidenceStore(artifacts, { runId: 'run-db', caseId: 'M-TC-1', attempt: 1 }, redactor);
  const fake = new FakeConnection();
  let created = 0;
  const profile = DataModelSchema.parse({ version: 1, connection: { kind: 'postgres', env: 'READONLY_DB' }, queries: options.queries ?? { byId: { sql: 'SELECT * FROM orders WHERE id = $1', parameters: [{ name: 'id', type: 'number' }] } } });
  const reader = new PostgresReader(profile, store, redactor, { ...options, env: { READONLY_DB: options.url ?? 'postgres://readonly:connection-secret@localhost/test' }, createConnection: () => { created++; return fake; } });
  const evidence = async (ids: string[]) => {
    const index = JSON.parse((await artifacts.readBytes('runs/run-db/cases/M-TC-1/attempts/1/evidence/index.json'))!.toString()) as { id: string; path: string }[];
    return Promise.all(ids.map(async id => JSON.parse((await artifacts.readBytes(index.find(x => x.id === id)!.path))!.toString())));
  };
  return { reader, fake, evidence, created: () => created };
}
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('PostgreSQL 只读工具（假连接，真实守卫/采证）', () => {
  it('具名查询按只读事务与超时顺序执行，参数独立绑定，结果和证据结构化脱敏', async () => {
    const { reader, fake, evidence } = await setup();
    const result = await reader.query({ name: 'byId', params: [7] }, meta, signal());
    expect(fake.calls.map(x => x.text)).toEqual(['BEGIN READ ONLY', "SET LOCAL statement_timeout = '10000ms'", "SET LOCAL lock_timeout = '2000ms'", expect.stringContaining('pg_roles'), 'SELECT * FROM orders WHERE id = $1', 'ROLLBACK']);
    expect(fake.calls[4]!.values).toEqual([7]);
    expect(fake.closed).toBe(true);
    expect(result.rows).toEqual([{ id: 1, password: '[REDACTED]', nested: { accessToken: '[REDACTED]' } }]);
    expect(result.truncated).toBe(false);
    const saved = await evidence(result.evidenceIds);
    expect(saved[0].status).toBe('success');
    expect(JSON.stringify([result, saved])).not.toMatch(/unknown-password|unknown-token|connection-secret/);
  });
  it.each([{ sql: 'DELETE FROM orders', params: [] }, { name: 'byId', params: ['wrong'] }, { name: 'missing', params: [] }, { sql: 'SELECT $2', params: [1] }])('拒绝输入时不建立连接且保存未执行证据', async input => {
    const { reader, created, evidence } = await setup();
    const failure = await reader.query(input, meta, signal()).catch(e => e);
    expect(failure.kind).toBe('blocked'); expect(created()).toBe(0);
    expect((await evidence(failure.evidenceIds))[0]).toMatchObject({ status: 'blocked', sent: false });
  });
  it('拒绝特权账号，不运行用户查询', async () => {
    const { reader, fake } = await setup(); fake.privileged = true;
    await expect(reader.query({ sql: 'SELECT 1' }, meta, signal())).rejects.toMatchObject({ kind: 'blocked' });
    expect(fake.calls.some(x => x.text === 'SELECT 1')).toBe(false); expect(fake.closed).toBe(true);
  });
  it.each([{ maxRows: 1 }, { maxBytes: 10 }])('超限明确截断并终止连接，不冒充完整集合', async options => {
    const { reader, fake, evidence } = await setup(options); fake.rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = await reader.query({ sql: 'SELECT id FROM orders' }, meta, signal());
    expect(result.truncated).toBe(true); expect(result.notice).toContain('完整集合'); expect(fake.closed).toBe(true);
    expect((await evidence(result.evidenceIds))[0].truncated).toBe(true);
    expect(result.rows.length).toBeLessThan(3);
  });
  it('中断真正关闭挂起查询连接并保存取消证据', async () => {
    const { reader, fake, evidence } = await setup(); fake.pending = () => {};
    const controller = new AbortController();
    const running = reader.query({ sql: 'SELECT 1' }, meta, controller.signal).catch(e => e);
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    const failure = await running;
    expect(fake.closed).toBe(true); expect(failure.kind).toBe('cancelled');
    expect((await evidence(failure.evidenceIds))[0].status).toBe('cancelled');
  });
  it('已中断不连接；数据库原始错误和 SQL 字面量不进入返回或证据', async () => {
    const { reader, fake, evidence } = await setup();
    const controller = new AbortController(); controller.abort();
    await expect(reader.query({ sql: 'SELECT 1' }, meta, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fake.connected).toBe(false);
    fake.failure = new Error('postgres://readonly:connection-secret@localhost/test raw-password');
    const failure = await reader.query({ sql: "SELECT 'literal-password'" }, meta, signal()).catch(e => e);
    expect(failure.kind).toBe('database');
    expect(JSON.stringify([failure, await evidence(failure.evidenceIds)])).not.toMatch(/connection-secret|raw-password|literal-password/);
  });
  it('参数中的注入文本不拼接进 SQL，多字段输入不建立连接', async () => {
    const { reader, fake, created } = await setup();
    const injection = "x'; DELETE FROM orders; --";
    await reader.query({ sql: 'SELECT $1::text AS value', params: [injection] }, meta, signal());
    expect(fake.calls[4]).toEqual({ text: 'SELECT $1::text AS value', values: [injection] });
    await expect(reader.query({ name: 'byId', sql: 'SELECT 1', params: [7] }, meta, signal())).rejects.toMatchObject({ kind: 'blocked' });
    expect(created()).toBe(1);
  });
  it.each(['postgres://', 'postgres://readonly@localhost/test', 'postgres://readonly:@localhost/test', 'postgres://:secret@localhost/test', 'postgres://readonly:secret@/test', 'postgres://readonly:secret@localhost/'])('合法 SQL 遇不完整 URL 时拒绝，污染的 PG 环境不能补全地址或凭证：%s', async url => {
    for (const [key, value] of Object.entries({ PGHOST: 'fixture.invalid', PGPORT: '6543', PGUSER: 'fixture_writer', PGPASSWORD: 'fixture-secret', PGDATABASE: 'fixture_db', PGPASSFILE: 'must-not-read' })) vi.stubEnv(key, value);
    const { reader, created, evidence } = await setup({ url });
    const failure = await reader.query({ sql: 'SELECT 1' }, meta, signal()).catch(e => e);
    expect(failure).toMatchObject({ kind: 'blocked' });
    expect(created()).toBe(0);
    expect((await evidence(failure.evidenceIds))[0]).toMatchObject({ status: 'blocked', sent: false });
  });
  it.each([
    { value: [1, 2], want: '[1,2]' }, { value: { a: 1 }, want: '{"a":1}' },
    { value: 'hello', want: '"hello"' }, { value: '123', want: '"123"' }, { value: 'null', want: '"null"' },
    { value: 123, want: '123' }, { value: true, want: 'true' }, { value: false, want: 'false' },
    { value: null, want: null },
  ])('具名 json 值按声明编码后绑定，SQL NULL 独立保留：$value', async ({ value, want }) => {
    const { reader, fake } = await setup({ queries: { jsonValue: { sql: 'SELECT $1::jsonb AS value', parameters: [{ name: 'payload', type: 'json', nullable: true }] } } });
    await reader.query({ name: 'jsonValue', params: [value] }, meta, signal());
    expect(fake.calls[4]).toEqual({ text: 'SELECT $1::jsonb AS value', values: [want] });
  });
  it('非 nullable json 拒绝 JS null，普通声明类型不编码', async () => {
    const { reader, fake, created } = await setup({ queries: {
      strict: { sql: 'SELECT $1::jsonb AS value', parameters: [{ name: 'payload', type: 'json', nullable: false }] },
      scalars: { sql: 'SELECT $1, $2, $3', parameters: [{ name: 's', type: 'string' }, { name: 'n', type: 'number' }, { name: 'b', type: 'boolean' }] },
    } });
    await expect(reader.query({ name: 'strict', params: [null] }, meta, signal())).rejects.toMatchObject({ kind: 'blocked' });
    expect(created()).toBe(0);
    await reader.query({ name: 'scalars', params: ['123', 2, false] }, meta, signal());
    expect(fake.calls[4]!.values).toEqual(['123', 2, false]);
  });
  it('临时 SELECT 没有声明类型，保留 pg 原生 values 语义', async () => {
    const { reader, fake } = await setup();
    await reader.query({ sql: 'SELECT $1, $2, $3, $4, $5, $6', params: [[1, 2], { a: 1 }, 'null', 2, false, null] }, meta, signal());
    expect(fake.calls[4]!.values).toEqual([[1, 2], { a: 1 }, 'null', 2, false, null]);
  });
  it('数据库工具严格输入且转发取消信号与宿主元信息', async () => {
    const { reader } = await setup(); const [tool] = createDbTools(reader, () => meta);
    expect(tool!.category).toBe('db');
    expect(tool!.input.safeParse({ sql: 'SELECT 1', connection: 'evil' }).success).toBe(false);
    const result = await tool!.execute({ sql: 'SELECT 1' }, { signal: signal() }) as { evidenceIds: string[] };
    expect(result.evidenceIds).toHaveLength(1);
    const controller = new AbortController(); controller.abort();
    expect(await tool!.execute({ sql: 'SELECT 1' }, { signal: controller.signal })).toMatchObject({ error: { kind: 'cancelled' }, evidenceIds: [expect.any(String)] });
  });
});
