import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, GuardrailsSchema, type Actor } from '@crosscheck/core';
import * as tools from '../src/index';

const skip = process.env.CROSSCHECK_REAL_BROWSER !== '1';
const roots: string[] = [], servers: Server[] = [], hosts: tools.BrowserHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(h => h.close()));
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const secret = 'AUTH_BROWSER_SENTINEL_9281';
const meta = { actionId: 'a-auth', phase: 'preparation' as const };
async function listen(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function setup(baseURL: string, allowedHosts: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'auth-browser-')); roots.push(root);
  const artifacts = new ArtifactStore(root), redactor = tools.createEvidenceRedactor();
  const store = new tools.EvidenceStore(artifacts, { runId: 'run-auth', caseId: 'M-TC-1', attempt: 1 }, redactor);
  const browser = new tools.BrowserHost({ baseURL, evidence: store, redactor, env: { PASSWORD: secret } }); hosts.push(browser);
  const adapter = new tools.BrowserAuthenticationAdapter(browser, baseURL, redactor);
  const host = new tools.AuthenticationHost(baseURL, new tools.HttpClient(new tools.RequestPolicy(GuardrailsSchema.parse({ allowedHosts })), store, redactor), new tools.ApprovedCommandRunner(artifacts, 'run-auth', redactor), store, redactor, { env: { TOKEN: secret }, browser: adapter });
  return { browser, host, store, redactor, signal: new AbortController().signal };
}
describe.skipIf(skip)('浏览器认证与 HTTP 同源身份', () => {
  it.each(['form', 'replay'] as const)('%s 消费批准动作并按 URL 匹配 cookie，动态凭证在下一次截图前脱敏', async kind => {
    const seen: string[] = [];
    const base = await listen((req, res) => {
      if (req.url === '/login') { res.setHeader('Content-Type', 'text/html'); res.end('<form method="post" action="/login-done"><input name="password" type="password"><button>登录</button></form>'); }
      else if (req.url === '/login-done') { res.setHeader('Set-Cookie', [`sid=${secret}; Path=/`, 'wrong=wrong-path; Path=/private']); res.setHeader('Content-Type', 'text/html'); res.end(`<p id="ready">登录成功</p><p>${secret}</p>`); }
      else { seen.push(req.headers.cookie ?? ''); res.setHeader('Content-Type', 'application/json'); res.end('{"actor":"member"}'); }
    });
    const s = await setup(base, [new URL(base).host]);
    const session = await s.host.authenticate({ kind, environment: 'local', actions: [{ kind: 'goto', url: '/login' }, { kind: 'fill', selector: 'input', env: 'PASSWORD' }, { kind: 'click', selector: 'button' }, { kind: 'waitFor', selector: '#ready' }] }, meta, s.signal);
    const response = await session.client.request({ url: `${base}/who`, signal: s.signal }, { ...meta, actionId: 'a-http' });
    const native = await s.browser.getSession(s.signal);
    await native.context.addCookies([{ name: 'secure', value: 'secure-only', domain: 'example.test', path: '/', secure: true }, { name: 'domain', value: 'other-domain', domain: 'different.test', path: '/' }]);
    expect((await native.context.cookies(['http://example.test/'])).some(c => c.name === 'secure')).toBe(false);
    expect((await native.context.cookies(['https://example.test/'])).map(c => c.name)).toEqual(['secure']);
    expect(seen.at(-1)).toBe(`sid=${secret}`);
    expect((await s.store.readHttpResponse(response.evidenceIds.at(-1)!)).body).toEqual({ actor: 'member' });
    expect(s.redactor.text(secret)).toBe('[REDACTED]');
    await s.browser.perform({ kind: 'observe' }, { actionId: 'a-observe', phase: 'execution' }, s.signal);
    expect(JSON.stringify(session)).not.toContain(secret);
  }, 30000);
  it('页面动态认证头分量在后续截图前登记共享redactor', async () => {
    const dynamic = 'PAGE_DYNAMIC_BEARER_SENTINEL';
    const base = await listen((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<p>就绪</p><script>fetch('/api',{headers:{Authorization:'Bearer ${dynamic}'}})</script>`); });
    const s = await setup(base, [new URL(base).host]);
    await s.browser.perform({ kind: 'navigate', url: '/' }, meta, s.signal);
    expect(s.redactor.text(dynamic)).toBe('[REDACTED]');
  });
  it('prepare 已启动浏览器后仍可配置 header；HTTP 同源重定向重新匹配 path cookie', async () => {
    const seen: string[] = [];
    const base = await listen((req, res) => { seen.push(req.headers.cookie ?? ''); if (req.url === '/private/redirect') { res.writeHead(302, { location: '/public' }); res.end(); } else { res.setHeader('Content-Type', 'text/html'); res.end('<p>就绪</p>'); } });
    const s = await setup(base, [new URL(base).host]);
    await s.browser.perform({ kind: 'navigate', url: '/' }, meta, s.signal);
    const native = await s.browser.getSession(s.signal);
    await native.context.addCookies([{ name: 'private', value: 'path-only', url: `${base}/private/` }]);
    const session = await s.host.authenticate({ kind: 'token', env: 'TOKEN', inject: { kind: 'header', name: 'X-Actor' } }, meta, s.signal);
    await session.client.request({ url: `${base}/private/redirect` }, meta);
    expect(seen.slice(-2)).toEqual(['private=path-only', '']);
  });
  it.each(['local', 'session'] as const)('storage %s 仅选定 origin 注入且不进入外站', async storage => {
    const other = await listen((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<p>外站</p>'); });
    const base = await listen((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<p>站内</p>'); });
    const s = await setup(base, [new URL(base).host, new URL(other).host]);
    await s.host.authenticate({ kind: 'token', env: 'TOKEN', inject: { kind: 'storage', storage, name: 'auth' } }, meta, s.signal);
    await s.browser.perform({ kind: 'navigate', url: base }, meta, s.signal);
    const page = (await s.browser.getSession(s.signal)).page;
    expect(await page.evaluate(kind => (kind === 'local' ? localStorage : sessionStorage).getItem('auth'), storage)).toBe(secret);
    await s.browser.perform({ kind: 'navigate', url: other }, meta, s.signal);
    expect(await page.evaluate(kind => (kind === 'local' ? localStorage : sessionStorage).getItem('auth'), storage)).toBeNull();
  });
  it.each(['header', 'command', 'cookie'] as const)('%s 主 page 每跳作用域隔离，跨站页面网络照常成功', async kind => {
    const seen: { site: string; url: string; identity?: string }[] = [];
    let base = '';
    const other = await listen((req, res) => { seen.push({ site: 'other', url: req.url!, identity: req.headers['x-actor'] as string }); if (req.url === '/back') { res.writeHead(302, { location: `${base}/final` }); res.end(); } else { res.setHeader('Content-Type', 'text/html'); res.end('<p>外站成功</p>'); } });
    base = await listen((req, res) => { seen.push({ site: 'base', url: req.url!, identity: kind === 'cookie' ? req.headers.cookie : req.headers['x-actor'] as string }); if (req.url === '/redirect') { res.writeHead(302, { location: `${other}/back` }); res.end(); } else { res.setHeader('Content-Type', 'text/html'); res.end(`<p>站内成功</p><script>fetch('${other}/fetch',{mode:'no-cors'})</script>`); } });
    const s = await setup(base, [new URL(base).host, new URL(other).host]);
    const actor: Actor = kind === 'command' ? { kind, command: { program: process.execPath, argv: ['-e', `console.log(JSON.stringify({headers:{'X-Actor':'${secret}'}}))`], env: {} } } : { kind: 'token', env: 'TOKEN', inject: { kind, name: kind === 'cookie' ? 'sid' : 'X-Actor' } };
    const session = await s.host.authenticate(actor, meta, s.signal);
    await s.browser.perform({ kind: 'navigate', url: '/redirect' }, meta, s.signal);
    const page = (await s.browser.getSession(s.signal)).page;
    expect(page.url()).toBe(`${base}/final`);
    expect(seen.find(x => x.site === 'base' && x.url === '/final')?.identity).toBe(kind === 'cookie' ? `sid=${secret}` : secret);
    expect(seen.filter(x => x.site === 'other').every(x => x.identity === undefined)).toBe(true);
    expect(seen.some(x => x.site === 'other' && x.url === '/fetch')).toBe(true);
    await session.client.request({ url: `${other}/http` }, meta);
    expect(seen.at(-1)?.identity).toBeUndefined();
    if (kind !== 'cookie') {
      const popup = await page.context().newPage(); await popup.goto(`${base}/popup`);
      expect(seen.find(x => x.url === '/popup')?.identity).toBeUndefined();
    }
  }, 30000);
});
