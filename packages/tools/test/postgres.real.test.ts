import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, DataModelSchema } from '../../core/src/index';
import { createEvidenceRedactor, EvidenceStore } from '../src/index';
import { createPgConnection, DbOperationError, PostgresReader, type PgConnection } from '../src/db/postgres';

const url = process.env.CROSSCHECK_TEST_DATABASE_URL;
let root: string;
let reader: PostgresReader;
const meta = { actionId: 'a-real-db', phase: 'execution' as const };
beforeAll(async () => {
  if (!url) return;
  root = await mkdtemp(path.join(tmpdir(), 'db-real-'));
  const redactor = createEvidenceRedactor([], [url]);
  reader = new PostgresReader(DataModelSchema.parse({ version: 1, connection: { kind: 'postgres', env: 'CROSSCHECK_TEST_DATABASE_URL' }, queries: {} }), new EvidenceStore(new ArtifactStore(root), { runId: 'run-pg', caseId: 'M-TC-1', attempt: 1 }, redactor), redactor);
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe.skipIf(!url)('专用 PostgreSQL 集成（必须显式授权 CROSSCHECK_TEST_DATABASE_URL）', () => {
  it('适配器返回数据库真实结果，参数注入只是数据', async () => {
    const value = "x'; DELETE FROM anything; --";
    const result = await reader.query({ sql: 'SELECT $1::text AS value', params: [value] }, meta, new AbortController().signal);
    expect(result.rows).toEqual([{ value }]);
    expect(result.evidenceIds).toHaveLength(1);
  });
  it('扩展协议不能执行多语句，即使直接使用底层连接', async () => {
    const client = createPgConnection(url!);
    try {
      await client.connect();
      await expect(client.run('SELECT 1; SELECT 2', [], () => {})).rejects.toMatchObject({ code: '42601' });
    } finally { await client.close(); }
  });
  it('只读事务禁止写入，不创建业务对象', async () => {
    const client = createPgConnection(url!);
    try {
      await client.connect();
      await client.run('BEGIN READ ONLY', [], () => {});
      await expect(client.run('CREATE TABLE crosscheck_readonly_must_not_exist (id int)', [], () => {})).rejects.toMatchObject({ code: '25006' });
    } finally { await client.close(); }
  });
  it('服务端 statement_timeout 确实终止查询，不依赖客户端 query_timeout', async () => {
    const client = createPgConnection(url!);
    try {
      await client.connect(); await client.run('BEGIN READ ONLY', [], () => {});
      await client.run("SET LOCAL statement_timeout = '100ms'", [], () => {});
      await expect(client.run('SELECT pg_sleep(10)', [], () => {})).rejects.toMatchObject({ code: '57014' });
    } finally { await client.close(); }
  });
  it('专属 socket 关闭会让服务器活动查询消失', async () => {
    const client = createPgConnection(url!);
    const observer = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    let pid = 0;
    try {
      await client.connect(); await observer.connect();
      await client.run('SELECT pg_backend_pid() AS pid', [], row => { pid = row.pid as number; });
      expect(pid).toBeGreaterThan(0);
      const pending = client.run('SELECT pg_sleep(30)', [], () => {}).then(() => 'completed', () => 'disconnected');
      await expect.poll(async () => (await observer.query("SELECT state, query FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0], { timeout: 3_000 }).toMatchObject({ state: 'active', query: 'SELECT pg_sleep(30)' });
      await client.close(); expect(await pending).toBe('disconnected');
      await expect.poll(async () => Number((await observer.query('SELECT count(*) FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0].count), { timeout: 3_000 }).toBe(0);
    } finally { await client.close(); await observer.end(); }
  });
  it('Reader 在已确认 active 的长查询中响应 signal，分类取消、采证并移除会话', async () => {
    const observer = createPgConnection(url!);
    const controller = new AbortController();
    const artifacts = new ArtifactStore(root);
    const redactor = createEvidenceRedactor([], [url!]);
    let pid = 0;
    let connection: PgConnection | undefined;
    // 只替换已过守卫的用户 SELECT 的服务器执行负载；不修改守卫，不把 pg_sleep 当作守卫验证。
    const cancellingReader = new PostgresReader(DataModelSchema.parse({ version: 1, connection: { kind: 'postgres', env: 'CROSSCHECK_TEST_DATABASE_URL' }, queries: {} }), new EvidenceStore(artifacts, { runId: 'run-cancel', caseId: 'M-TC-1', attempt: 1 }, redactor), redactor, {
      createConnection(value) {
        const actual = createPgConnection(value); connection = actual;
        return {
          async connect() { await actual.connect(); await actual.run('SELECT pg_backend_pid() AS pid', [], row => { pid = row.pid as number; }); },
          run(text, values, row) { return actual.run(text === 'SELECT 1 AS cancel_probe' ? 'SELECT pg_sleep(30)' : text, values, row); },
          close() { return actual.close(); },
        };
      },
    });
    let running: Promise<unknown> | undefined;
    try {
      await observer.connect();
      running = cancellingReader.query({ sql: 'SELECT 1 AS cancel_probe' }, meta, controller.signal).catch(error => error);
      await expect.poll(() => pid, { timeout: 3_000 }).toBeGreaterThan(0);
      await expect.poll(async () => {
        let activity: Record<string, unknown> | undefined;
        await observer.run('SELECT state, query FROM pg_stat_activity WHERE pid = $1', [pid], row => { activity = row; });
        return activity;
      }, { timeout: 3_000 }).toMatchObject({ state: 'active', query: 'SELECT pg_sleep(30)' });
      controller.abort();
      const failure = await running;
      expect(failure).toBeInstanceOf(DbOperationError);
      expect(failure).toMatchObject({ kind: 'cancelled', evidenceIds: [expect.any(String)] });
      const index = JSON.parse((await artifacts.readBytes('runs/run-cancel/cases/M-TC-1/attempts/1/evidence/index.json'))!.toString()) as { id: string; path: string }[];
      const record = index.find(item => item.id === (failure as DbOperationError).evidenceIds[0])!;
      expect(JSON.parse((await artifacts.readBytes(record.path))!.toString())).toMatchObject({ status: 'cancelled', sent: true });
      await expect.poll(async () => {
        let count = -1;
        await observer.run('SELECT count(*) FROM pg_stat_activity WHERE pid = $1', [pid], row => { count = Number(row.count); });
        return count;
      }, { timeout: 3_000 }).toBe(0);
    } finally { controller.abort(); await running; await connection?.close(); await observer.close(); }
  });
  it('服务端 lock_timeout 生效（只使用本测试创建的独立 schema）', async () => {
    const owner = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const client = createPgConnection(url!);
    const name = `crosscheck_lock_${process.pid}_${Date.now()}`;
    try {
      await owner.connect();
      await owner.query(`CREATE SCHEMA ${name}`);
      await owner.query(`CREATE TABLE ${name}.items (id int)`);
      await owner.query('BEGIN'); await owner.query(`LOCK TABLE ${name}.items IN ACCESS EXCLUSIVE MODE`);
      await client.connect(); await client.run('BEGIN READ ONLY', [], () => {});
      await client.run("SET LOCAL lock_timeout = '100ms'", [], () => {});
      await expect(client.run(`SELECT * FROM ${name}.items`, [], () => {})).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await client.close();
      await owner.query('ROLLBACK'); await owner.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); await owner.end();
    }
  });
});
