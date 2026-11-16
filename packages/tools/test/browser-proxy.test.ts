import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { connect, type Socket } from 'node:net';
import { LocalForwardProxy } from '../src/browser/network-proxy';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function target(host = '127.0.0.1') {
  const counts = { tcp: 0, http: 0, upgrade: 0, headers: {} as IncomingHttpHeaders, path: '' };
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => { counts.http++; counts.headers = req.headers; counts.path = req.url!; res.end('允许'); });
  server.on('connection', (s) => { counts.tcp++; sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (_r, s) => { counts.upgrade++; s.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  cleanups.push(async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); });
  return { server, counts, port: (server.address() as { port: number }).port };
}
async function proxy(allowedHosts: string[]) {
  const p = new LocalForwardProxy({ allowedHosts });
  const port = await p.start(); cleanups.push(() => p.stop());
  return { p, port };
}
function http(port: number, url: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: url, headers: { host: new URL(url).host, ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end();
  });
}
function tunnel(port: number, authority: string) {
  return new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'CONNECT', path: authority, headers: { host: authority } });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode!, socket })); req.on('error', reject); req.end();
  });
}
async function raw(port: number, text: string) {
  return new Promise<string>((resolve, reject) => {
    const s = connect(port, '127.0.0.1'); let result = '';
    s.on('connect', () => s.write(text)); s.on('data', (b) => { result += b; }); s.on('error', reject); s.on('close', () => resolve(result));
  });
}

describe('本地 host:port 代理（真实 TCP）', () => {
  it('允许 HTTP 保留 origin/路径，剥离代理凭证及逐跳头；禁止目标连 TCP 都不建立', async () => {
    const A = await target(), F = await target(); const { port } = await proxy([`127.0.0.1:${A.port}`]);
    expect(await http(port, `http://127.0.0.1:${A.port}/a?q=1`, { 'proxy-authorization': 'private-test', connection: 'x-secret', 'x-secret': 'private-test' })).toBe(200);
    expect(A.counts.path).toBe('/a?q=1'); expect(A.counts.headers.host).toBe(`127.0.0.1:${A.port}`);
    expect(A.counts.headers['proxy-authorization']).toBeUndefined(); expect(A.counts.headers['x-secret']).toBeUndefined();
    expect(await http(port, `http://127.0.0.1:${F.port}/f`)).toBe(403);
    expect(F.counts).toMatchObject({ tcp: 0, http: 0, upgrade: 0 });
  });
  it('CONNECT 允许活隧道，禁止目标零连接，stop 幂等并结束隧道', async () => {
    const A = await target(), F = await target(); const { p, port } = await proxy([`127.0.0.1:${A.port}`]);
    const ok = await tunnel(port, `127.0.0.1:${A.port}`); expect(ok.status).toBe(200); expect(A.counts.tcp).toBe(1);
    const no = await tunnel(port, `127.0.0.1:${F.port}`); expect(no.status).toBe(403); no.socket.destroy();
    expect(F.counts.tcp).toBe(0);
    const closed = new Promise<void>((r) => ok.socket.once('close', () => r())); ok.socket.resume();
    await Promise.all([p.stop(), p.stop()]); await closed;
  });
  it('无端口条目及 IPv6 字面量使用同一匹配器', async () => {
    const A = await target('::1'); const { port } = await proxy(['[::1]']);
    expect(await http(port, `http://[::1]:${A.port}/v6`)).toBe(200);
    const t = await tunnel(port, `[::1]:${A.port}`); expect(t.status).toBe(200); t.socket.destroy();
  });
  it.each(['127.0.0.1', '127.0.0.1:0', '127.0.0.1:65536', 'user@127.0.0.1:80', '127.0.0.1:80/path', '::1:80', '[::1]:80?q', '127.0.0.1:080'])('拒绝歧义 CONNECT authority %s', async (authority) => {
    const { port } = await proxy(['127.0.0.1', '[::1]']); const t = await tunnel(port, authority); expect(t.status).toBe(400); t.socket.destroy();
  });
  it('拒绝 userinfo、冲突或重复 Host，验证先于连接', async () => {
    const A = await target(); const { port } = await proxy(['127.0.0.1']);
    expect(await http(port, `http://user:pass@127.0.0.1:${A.port}/`)).toBe(400);
    expect(await http(port, `http://127.0.0.1:${A.port}/`, { host: 'other.test' })).toBe(400);
    const response = await raw(port, `GET http://127.0.0.1:${A.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${A.port}\r\nHost: 127.0.0.1:${A.port}\r\n\r\n`);
    expect(response).toContain('400'); expect(A.counts.tcp).toBe(0);
  });
  it('上游错误返回 502，客户端提前断开后 stop 不悬挂', async () => {
    const A = await target(); const unused = A.port;
    await new Promise<void>((r) => A.server.close(() => r()));
    const { p, port } = await proxy(['127.0.0.1']);
    expect(await http(port, `http://127.0.0.1:${unused}/`)).toBe(502);
    const t = await tunnel(port, `127.0.0.1:${unused}`); expect(t.status).toBe(502); t.socket.destroy();
    const s = connect(port, '127.0.0.1'); await new Promise<void>((r) => s.once('connect', r));
    s.write(`CONNECT 127.0.0.1:${unused} HTTP/1.1\r\nHost: 127.0.0.1:${unused}\r\n\r\n`); s.destroy();
    await p.stop();
  });
});
