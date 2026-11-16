import { afterEach, expect, it, vi } from 'vitest';
import pg from 'pg';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Socket } from 'node:net';
import { createPgConnection } from '../src/db/postgres';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanups.splice(0)) await close(); } finally { vi.unstubAllEnvs(); vi.restoreAllMocks(); } });
const frame = (type: string, data: Buffer = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5); header.write(type); header.writeInt32BE(4 + data.length, 1); return Buffer.concat([header, data]);
};
async function wireServer(hang = false, authenticate = false) {
  const startups: Record<string, string>[] = [];
  const passwords: string[] = [];
  const sslRequests: number[] = [];
  const sockets = new Set<Socket>();
  const received: string[] = [];
  const sql: string[] = [];
  let disconnected = false;
  const server = createServer(socket => {
    sockets.add(socket); let pending = Buffer.alloc(0); let startup = true;
    socket.on('error', () => {});
    socket.on('close', () => { disconnected = true; sockets.delete(socket); });
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (pending.length >= (startup ? 4 : 5)) {
        const length = pending.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (pending.length < length) return;
        const message = pending.subarray(0, length); pending = pending.subarray(length);
        if (startup) {
          if (length === 8 && message.readInt32BE(4) === 80877103) { sslRequests.push(1); socket.end('N'); return; }
          const fields = message.subarray(8).toString().split('\0');
          const config: Record<string, string> = {};
          for (let i = 0; i + 1 < fields.length && fields[i]; i += 2) config[fields[i]!] = fields[i + 1]!;
          startups.push(config);
          startup = false;
          const auth = Buffer.alloc(4); auth.writeInt32BE(authenticate ? 3 : 0);
          socket.write(authenticate ? frame('R', auth) : Buffer.concat([frame('R', auth), frame('Z', Buffer.from('I'))]));
          continue;
        }
        const type = message.toString('ascii', 0, 1); received.push(type);
        if (type === 'p') { passwords.push(message.subarray(5, -1).toString()); socket.write(Buffer.concat([frame('R', Buffer.alloc(4)), frame('Z', Buffer.from('I'))])); }
        if (type === 'P') { sql.push(message.subarray(6, message.indexOf(0, 6)).toString()); socket.write(frame('1')); }
        else if (type === 'B') socket.write(frame('2'));
        else if (type === 'D') socket.write(frame('n'));
        else if (type === 'E' && !hang) socket.write(frame('C', Buffer.from('SELECT 0\0')));
        else if (type === 'S' && !hang) socket.write(frame('Z', Buffer.from('I')));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  return { url: `postgres://readonly:test@127.0.0.1:${port}/test?sslmode=disable`, received, sql, startups, passwords, sslRequests, disconnected: () => disconnected };
}
const rejectedUrls = [
  'postgres://', 'postgres://readonly@localhost/test', 'postgres://readonly:@localhost/test',
  'postgres://:secret@localhost/test', 'postgres://readonly:secret@localhost/',
  'mysql://readonly:secret@localhost/test', 'postgres://readonly:secret@%2Ftmp/test',
  'postgres://readonly:secret@localhost/test?host=fixture.invalid',
  'postgres://readonly:secret@localhost/test?sslcert=must-not-read',
  'postgres://readonly:secret@localhost/test?sslkey=must-not-read',
  'postgres://readonly:secret@localhost/test?sslrootcert=must-not-read',
  'postgres://readonly:secret@localhost/test?options=-csearch_path%3Dfixture',
  ...['require', 'prefer', 'verify-ca', 'no-verify', 'unknown', ''].map(mode => `postgres://readonly:secret@localhost/test?sslmode=${mode}`),
  'postgres://readonly:secret@localhost/test?sslmode=disable&sslmode=verify-full',
  'postgres://readonly:secret@localhost/test#ignored',
];
it.each(rejectedUrls)('底层适配器同步拒绝非完整 TCP URL 或越权查询项：%s', url => {
  expect(() => createPgConnection(url)).toThrow();
});
it('完整 URL 使用批准 TCP 目标与凭证，不继承 PG options/身份/SSL 且不使用 pgpass（真实 pg，假服务端）', async () => {
  const approved = await wireServer(false, true);
  const ambient = await wireServer();
  const root = await mkdtemp(path.join(tmpdir(), 'pgpass-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const passfile = path.join(root, 'pgpass');
  await writeFile(passfile, '*:*:*:*:pgpass-secret\n', { mode: 0o600 });
  for (const [key, value] of Object.entries({
    PGHOST: '127.0.0.1', PGPORT: new URL(ambient.url).port, PGUSER: 'fixture_writer', PGDATABASE: 'fixture_db',
    PGPASSWORD: 'ambient-secret', PGPASSFILE: passfile, PGOPTIONS: '-c role=fixture_writer',
    PGAPPNAME: 'ambient-app', PGREPLICATION: 'database', PGCLIENT_ENCODING: 'invalid-encoding',
    PGSSLMODE: 'require', PGSSLNEGOTIATION: 'direct', PGCONNECT_TIMEOUT: '1',
  })) vi.stubEnv(key, value);
  const client = createPgConnection(approved.url);
  try {
    await client.connect(); await client.run('SELECT 1', [], () => {});
    expect(approved.passwords).toEqual(['test']);
    expect(approved.startups).toHaveLength(1);
    expect(approved.startups[0]).toMatchObject({ user: 'readonly', database: 'test', options: ' ', replication: 'false', application_name: 'crosscheck' });
    expect(JSON.stringify(approved.startups)).not.toMatch(/fixture|ambient/);
    expect(ambient.startups).toEqual([]);
    expect(approved.sql).toEqual(['SELECT 1']);
  } finally { await client.close(); }
  vi.stubEnv('PGPASSWORD', undefined);
  const explicit = createPgConnection(approved.url);
  try { await explicit.connect(); expect(approved.passwords).toEqual(['test', 'test']); } finally { await explicit.close(); }
});
it.each(['', '?sslmode=verify-full'])('默认和 verify-full 均要求 TLS，PGSSLMODE=disable 不能降级：%s', async query => {
  const server = await wireServer(); vi.stubEnv('PGSSLMODE', 'disable');
  const client = createPgConnection(server.url.replace('?sslmode=disable', query));
  try {
    await expect(client.connect()).rejects.toThrow();
    expect(server.sslRequests).toHaveLength(1); expect(server.startups).toEqual([]);
  } finally { await client.close(); }
});
it('省略 port 由宿主显式指定 5432，不继承 PGPORT', async () => {
  const clients: pg.Client[] = [];
  const original = pg.Client;
  vi.spyOn(pg, 'Client').mockImplementation(function (config: pg.ClientConfig) { const client = new original(config); clients.push(client); return client; } as unknown as typeof pg.Client);
  vi.stubEnv('PGPORT', '6543');
  const connection = createPgConnection('postgresql://readonly:test@localhost/test');
  expect(clients[0]!.port).toBe(5432);
  await connection.close();
});
it('真实 pg 客户端零参数查询也发扩展协议而非简单 Query 消息（假 PG 服务端）', async () => {
  const server = await wireServer();
  const client = createPgConnection(server.url);
  try {
    await client.connect(); await client.run('SELECT 1', [], () => {});
    expect(server.received).toEqual(['P', 'B', 'D', 'E', 'S']);
    expect(server.sql).toEqual(['SELECT 1']);
  } finally { await client.close(); }
});
it('真实 pg 挂起查询关闭专属 socket，不只是向调用方提前返回（假 PG 服务端）', async () => {
  const server = await wireServer(true);
  const client = createPgConnection(server.url);
  await client.connect();
  const pending = client.run('SELECT 1', [], () => {}).then(() => 'success', () => 'disconnected');
  await expect.poll(() => server.received.includes('E')).toBe(true);
  await client.close();
  expect(await pending).toBe('disconnected');
  await expect.poll(server.disconnected).toBe(true);
});
