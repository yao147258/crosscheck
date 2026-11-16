import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { hostPortAllowed } from '../../../core/src/index';

export interface ProxyAuditEvent {
  kind: 'allowed' | 'blocked';
  hostname: string;
  port: string;
}
export interface ProxyOptions {
  allowedHosts: string[];
  /** 只含主机端口，不包含路径、正文、凭证或原始请求。 */
  onEvent?(event: ProxyAuditEvent): void;
  onFatal?(reason: string): void;
}
interface Destination { hostname: string; port: string; authority: string; path: string }

/** CONNECT 不借用 URL 的宽松解析：必须显式端口且不接受默认端口、凭证或路径猜测。 */
function authority(value: string): { hostname: string; port: string } | undefined {
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[2]) > 65535) return;
  const hostname = match[1]!, port = match[2]!;
  if (!hostPortAllowed(hostname, port, [hostname])) return;
  return { hostname, port };
}
function hostHeaders(req: IncomingMessage): string[] {
  const hosts: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === 'host') hosts.push(req.rawHeaders[i + 1]!);
  return hosts;
}
function destination(req: IncomingMessage): Destination | undefined {
  const raw = req.url ?? '';
  if (!/^http:\/\//i.test(raw) || /[\\\s]/.test(raw)) return;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.username || url.password || url.hash) return;
    const hosts = hostHeaders(req);
    if (hosts.length !== 1 || hosts[0]!.toLowerCase() !== url.host.toLowerCase()) return;
    return { hostname: url.hostname, port: url.port || '80', authority: url.host, path: url.pathname + url.search };
  } catch { return; }
}
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function headers(req: { headers: IncomingMessage['headers'] }): OutgoingHttpHeaders {
  const excluded = new Set([...HOP_HEADERS, ...(req.headers.connection ?? '').split(',').map((h) => h.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(req.headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}
const netHost = (hostname: string) => hostname.replace(/^\[|\]$/g, '');

/** 仅负责 host:port 的本地代理；普通 HTTP(S) 的完整请求策略仍由 Fetch 守卫执行。 */
export class LocalForwardProxy {
  private server?: Server;
  private readonly sockets = new Set<Duplex>();
  private stopping?: Promise<void>;
  private starting?: Promise<number>;
  private readonly allowedHosts: string[];
  constructor(private readonly options: ProxyOptions) { this.allowedHosts = [...options.allowedHosts]; }

  start(): Promise<number> {
    if (this.stopping) return Promise.reject(new Error('代理已关闭'));
    if (this.starting) return this.starting;
    const server = this.server = createServer((req, res) => this.forward(req, res));
    server.on('connection', (socket) => this.track(socket));
    server.on('connect', (req, client, head) => this.tunnel(req, client, head));
    server.on('upgrade', (req, client, head) => this.upgrade(req, client, head));
    server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    this.starting = new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve((server.address() as { port: number }).port);
      });
    });
    server.on('error', () => { this.options.onFatal?.('本地代理故障'); void this.stop(); });
    server.on('close', () => { if (!this.stopping) this.options.onFatal?.('本地代理意外关闭'); });
    return this.starting;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = Promise.resolve().then(async () => {
      await this.starting?.catch(() => {});
      const closed = [...this.sockets].map((socket) => new Promise<void>((resolve) => { socket.once('close', resolve); socket.destroy(); }));
      const server = this.server;
      if (server?.listening) closed.push(new Promise<void>((resolve) => server.close(() => resolve())));
      await Promise.all(closed);
    });
    return this.stopping;
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => this.sockets.delete(socket));
    if (this.stopping) socket.destroy();
  }
  private allowed(target: { hostname: string; port: string }): boolean {
    const allowed = hostPortAllowed(target.hostname, target.port, this.allowedHosts);
    this.options.onEvent?.({ kind: allowed ? 'allowed' : 'blocked', hostname: target.hostname, port: target.port });
    return allowed;
  }
  private reject(client: Duplex, status: number): void {
    client.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  private tunnel(req: IncomingMessage, client: Duplex, head: Buffer): void {
    const target = authority(req.url ?? '');
    const hosts = hostHeaders(req);
    if (!target || hosts.length !== 1 || hosts[0]!.toLowerCase() !== req.url!.toLowerCase()) return this.reject(client, 400);
    if (!this.allowed(target)) return this.reject(client, 403);
    const upstream = connect({ host: netHost(target.hostname), port: Number(target.port) });
    this.track(upstream);
    let connected = false;
    client.once('close', () => upstream.destroy());
    upstream.once('error', () => { if (!connected) this.reject(client, 502); else client.destroy(); });
    upstream.once('connect', () => {
      if (client.destroyed || this.stopping) { upstream.destroy(); return; }
      connected = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.once('close', () => { if (connected) client.destroy(); });
  }
  private forward(req: IncomingMessage, res: ServerResponse): void {
    const target = destination(req);
    if (!target) { res.writeHead(400, { connection: 'close' }); res.end(); return; }
    if (!this.allowed(target)) { res.writeHead(403, { connection: 'close' }); res.end(); return; }
    const upstream = request({ host: netHost(target.hostname), port: Number(target.port), method: req.method, path: target.path, headers: { ...headers(req), host: target.authority }, agent: false }, (response) => {
      res.writeHead(response.statusCode ?? 502, headers(response)); response.pipe(res);
      response.once('error', () => res.destroy());
    });
    upstream.on('socket', (s) => this.track(s));
    upstream.once('error', () => { if (!res.headersSent) { res.writeHead(502, { connection: 'close' }); res.end(); } else res.destroy(); });
    req.once('aborted', () => upstream.destroy());
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  }
  private upgrade(req: IncomingMessage, client: Duplex, head: Buffer): void {
    const target = destination(req);
    if (!target || req.headers.upgrade?.toLowerCase() !== 'websocket') return this.reject(client, 400);
    if (!this.allowed(target)) return this.reject(client, 403);
    const upstream = request({ host: netHost(target.hostname), port: Number(target.port), method: req.method, path: target.path, headers: { ...headers(req), host: target.authority, connection: 'Upgrade', upgrade: 'websocket' }, agent: false });
    upstream.on('socket', (s) => this.track(s));
    client.once('close', () => upstream.destroy());
    upstream.once('error', () => this.reject(client, 502));
    upstream.once('response', (res) => { res.resume(); this.reject(client, 502); });
    upstream.once('upgrade', (res, socket, upstreamHead) => {
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries({ ...headers(res), connection: 'Upgrade', upgrade: 'websocket' }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head.length) socket.write(head);
      if (upstreamHead.length) client.write(upstreamHead);
      socket.pipe(client); client.pipe(socket);
      client.once('close', () => socket.destroy()); socket.once('close', () => client.destroy());
    });
    upstream.end();
  }
}
