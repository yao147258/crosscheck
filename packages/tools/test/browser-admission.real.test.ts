/**
 * 真实 Chromium 准入验证（非 mock）：
 * 使用 Playwright 1.65.0 对应的 Chromium revision 1254，三个 loopback 服务各自计数真实收到的请求：
 * - A（127.0.0.1，允许）：被测页面；
 * - C（localhost，允许）：跨站 iframe（OOPIF）与跨站跳转目标；
 * - F（127.0.0.1 另一端口，禁止）：任何请求或 WebSocket upgrade 计数都必须保持 0。
 *
 * Task 1 将 WebSocket 改为 host:port 准入；普通 HTTP(S) 仍执行完整 Fetch 策略。
 * 需显式设置 CROSSCHECK_REAL_BROWSER=1；WT/RTC 未禁用时保持真实失败，不标记预期失败。
 * 失败意味着安全准入阻塞，不能据此导出或接入浏览器工具。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createServer as tcpServer, type Socket } from 'node:net';
import { chromium, type Page } from 'playwright';
import { GuardrailsSchema } from '../../core/src/index';
import { RequestPolicy } from '../src/network/policy';
import { policyDecider, type GuardEvent } from '../src/browser/request-guard';
import { launchGuardedChromium, type GuardedBrowser } from '../src/browser/session';

// 浏览器工具暂缓期间默认不跑，显式开启才运行
const skip = process.env.CROSSCHECK_REAL_BROWSER !== '1';

interface Hit { path: string; method: string; headers: IncomingMessage['headers']; body: string }
interface Svc { server: Server; port: number; hits: Hit[]; upgrades: string[]; connections: number }

async function serve(host: string, handler: (req: IncomingMessage, body: string, res: import('node:http').ServerResponse, svc: Svc) => void): Promise<Svc> {
  const svc = { hits: [] as Hit[], upgrades: [] as string[] } as Svc;
  svc.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => { svc.hits.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers, body }); handler(req, body, res, svc); });
  });
  svc.connections = 0;
  svc.server.on('connection', () => svc.connections++);
  svc.server.on('upgrade', (req, socket) => { svc.upgrades.push(req.url ?? ''); socket.destroy(); });
  await new Promise<void>((r) => svc.server.listen(0, host, r));
  svc.port = (svc.server.address() as { port: number }).port;
  return svc;
}

let A: Svc, C: Svc, F: Svc, a: string, c: string, f: string, root: string;
let session: GuardedBrowser;
const events: GuardEvent[] = [];
const html = (res: import('node:http').ServerResponse, body: string) => { res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`); };

beforeAll(async () => {
  if (skip) return;
  F = await serve('127.0.0.1', (_req, _body, res) => { html(res, 'forbidden'); });
  f = `http://127.0.0.1:${F.port}`;
  C = await serve('127.0.0.1', (req, _body, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/child') return html(res, `child<iframe src="${f}/oopif-nested"></iframe><img src="${f}/oopif-img"><script>fetch('${f}/oopif-fetch').catch(()=>{});</script>`);
    html(res, 'c-page');
  });
  c = `http://localhost:${C.port}`;
  A = await serve('127.0.0.1', (req, _body, res) => {
    const u = new URL(req.url!, 'http://x');
    const to = u.searchParams.get('to') ?? '/';
    switch (u.pathname) {
      case '/redir': res.writeHead(Number(u.searchParams.get('code') ?? 302), { location: to }); return res.end();
      case '/cookie-redir': res.writeHead(302, { location: '/echo', 'set-cookie': 'sid=abc; Path=/' }); return res.end();
      case '/echo': return html(res, 'echo');
      case '/subresources': return html(res, `<img src="${f}/img"><script src="${f}/s.js"></script><link rel="stylesheet" href="${f}/c.css"><img src="/ok.png">
        <script>Promise.allSettled([fetch('${f}/fetch'), fetch('/redir?code=307&to=${encodeURIComponent(f + '/fetch-redir')}'), fetch('${f}/beacon-like',{method:'POST',body:'x'})]).then(()=>document.title='done');</script>`);
      case '/iframes': return html(res, `<iframe src="${f}/frame"></iframe><iframe src="/redir?code=302&to=${encodeURIComponent(f + '/frame-redir')}"></iframe><iframe src="${c}/child"></iframe>`);
      case '/popups': return html(res, `<script>
        window.open('${f}/popup-direct');
        window.open('/redir?code=302&to=${encodeURIComponent(f + '/popup-redir')}');
        window.open('${f}/popup-noopener','_blank','noopener');
        window.open('/popup-ok');
        </script><a id="l" target="_blank" href="${f}/popup-anchor">x</a>`);
      case '/worker': return html(res, `<script>new Worker('/worker.js');</script>`);
      case '/worker.js': res.setHeader('content-type', 'text/javascript'); return res.end(`fetch('${f}/worker-fetch').catch(()=>{}); fetch('/worker-ok').catch(()=>{}); try { importScripts('${f}/worker-import.js'); } catch (e) {}`);
      case '/sw': return html(res, `<script>navigator.serviceWorker && navigator.serviceWorker.register('/sw.js').then(()=>document.title='registered',()=>document.title='rejected');</script>`);
      case '/sw.js': res.setHeader('content-type', 'text/javascript'); return res.end(`fetch('${f}/sw-fetch');`);
      case '/ws': return html(res, `<script>
        const s1 = new WebSocket('ws://127.0.0.1:${F.port}/ws-forbidden'); s1.onerror=()=>{};
        const s2 = new WebSocket('ws://' + location.host + '/ws-allowed-host'); s2.onerror=()=>{};
        </script>`);
      case '/ws-popup': return html(res, `<script>window.open('/ws-immediate','_blank','noopener');</script>`);
      case '/ws-immediate': return html(res, `<script>const s = new WebSocket('ws://127.0.0.1:${F.port}/ws-popup-immediate'); s.onerror=()=>{};</script>`);
      case '/navs': return html(res, `<form id="fm" method="post" action="${f}/form-post"><input name="a" value="1"></form>`);
      case '/post': return html(res, `<script>
        Promise.allSettled([
          fetch('/api/ok',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({a:1})}),
          fetch('/api/override',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({_method:'DELETE'})}),
          fetch('/api/override-header',{method:'POST',headers:{'content-type':'application/json','x-http-method-override':'DELETE'},body:'{}'}),
          fetch('/api/multipart',{method:'POST',body:(()=>{const d=new FormData();d.append('a','1');return d;})()}),
          fetch('/api/forbidden-write',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),
        ]).then(()=>document.title='done');</script>`);
      case '/download': return html(res, `<a id="d1" href="${f}/file.bin" download>d1</a><a id="d2" href="/file.bin" download>d2</a>`);
      case '/file.bin': res.setHeader('content-type', 'application/octet-stream'); res.setHeader('content-disposition', 'attachment; filename=x.bin'); return res.end('bin');
      default: return html(res, 'ok');
    }
  });
  a = `http://127.0.0.1:${A.port}`;
  root = await mkdtemp(path.join(tmpdir(), 'cc-browser-'));
  const guardrails = GuardrailsSchema.parse({ allowedHosts: [`127.0.0.1:${A.port}`, `localhost:${C.port}`, `127.0.0.1:${C.port}`], forbidden: [{ method: 'POST', path: '/api/forbidden-write' }] });
  session = await launchGuardedChromium({ allowedHosts: guardrails.allowedHosts, userDataDir: path.join(root, '.crosscheck', 'browser', 'profile'), guard: { decide: policyDecider(new RequestPolicy(guardrails)), onEvent: (e) => events.push(e) } });
}, 60_000);

afterAll(async () => {
  if (skip) return;
  if (session?.fatalReason) console.log('[诊断] 守卫 fatal：', session.fatalReason);
  console.log('[诊断] attach：', JSON.stringify(session?.mux.attachLog));
  await session?.close();
  for (const s of [A, C, F]) { s?.server.closeAllConnections(); await new Promise<void>((r) => s ? s.server.close(() => r()) : r()); }
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));
const hitsOn = (svc: Svc, prefix: string) => svc.hits.filter((h) => h.path.startsWith(prefix)).length;
/**
 * 被拒绝的导航：goto 必须以 ERR_BLOCKED_BY_CLIENT 失败。
 * 随后等待 chrome-error 错误页提交——已用无守卫的官方 connectOverCDP(ws) 对照复现：
 * 不等待时 Playwright 会把迟到的错误页提交当作下一次导航的“中断”，与守卫无关。
 */
async function expectErrorCommit(p: Page, action: () => Promise<unknown>) {
  // 先注册监听再执行动作，避免错误页提交早于 goto 拒绝时漏掉事件
  let seen = false;
  const on = (fr: import('playwright').Frame) => { if (fr === p.mainFrame() && fr.url().startsWith('chrome-error:')) seen = true; };
  p.on('framenavigated', on);
  try {
    await action();
    const deadline = Date.now() + 5000;
    while (!seen && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(seen).toBe(true);
  } finally { p.off('framenavigated', on); }
}
async function expectBlockedGoto(p: Page, url: string) {
  await expectErrorCommit(p, () => expect(p.goto(url)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/));
}

describe.skipIf(skip)('真实 Chromium 发送前准入（loopback 计数）', { timeout: 30_000 }, () => {
  it('浏览器版本与 Playwright 1.65.0 期望 revision 1254 一致', async () => {
    const exe = chromium.executablePath();
    expect(exe).toMatch(/chromium-1254/);
    expect(existsSync(exe)).toBe(true);
    expect(session.browser.version()).toMatch(/^158\./);
  });

  it('对照组：禁止服务的计数器和 upgrade 计数器确实工作', async () => {
    const before = F.hits.length;
    await fetch(`${f}/control`);
    expect(F.hits.length).toBe(before + 1);
    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port: F.port, path: '/ws-control', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      req.on('error', () => resolve()); req.on('upgrade', () => resolve()); req.on('close', () => resolve()); req.end();
    });
    expect(F.upgrades).toContain('/ws-control');
    expect(F.connections).toBeGreaterThan(0);
    F.hits.length = 0; F.upgrades.length = 0; F.connections = 0;
  });

  let page: Page;
  it('主页面导航到禁止服务：0 次访问', async () => {
    const context = await session.browser.newContext();
    page = await context.newPage();
    await expectBlockedGoto(page, `${f}/direct`);
    await settle(300);
    expect(F.hits).toHaveLength(0);
  });

  it.each([301, 302, 303, 307, 308])('%i 重定向每一跳在发送前检查：跳向禁止服务 0 次访问', async (code) => {
    const before = hitsOn(A, '/redir');
    await expectBlockedGoto(page, `${a}/redir?code=${code}&to=${encodeURIComponent(f + '/after-redirect')}`);
    expect(hitsOn(A, '/redir')).toBe(before + 1);
    expect(F.hits).toHaveLength(0);
  });

  it.each([301, 302, 303, 307, 308])('%i 允许的跨站重定向保持真实导航语义（最终 URL 与目标计数）', async (code) => {
    const before = hitsOn(C, '/landing');
    const response = await page.goto(`${a}/redir?code=${code}&to=${encodeURIComponent(c + '/landing')}`);
    expect(response?.status()).toBe(200);
    expect(page.url()).toBe(`${c}/landing`);
    expect(hitsOn(C, '/landing')).toBe(before + 1);
  });

  it('相对 Location 与重定向上 Set-Cookie 的 cookie 在下一跳生效', async () => {
    await page.goto(`${a}/cookie-redir`);
    expect(page.url()).toBe(`${a}/echo`);
    const echo = A.hits.filter((h) => h.path === '/echo').at(-1)!;
    expect(echo.headers.cookie).toContain('sid=abc');
    expect(F.hits).toHaveLength(0);
  });

  it('页面子资源/fetch/fetch 跟随重定向：禁止服务 0 次访问，允许资源正常', async () => {
    const okBefore = hitsOn(A, '/ok.png');
    await page.goto(`${a}/subresources`);
    await page.waitForFunction('document.title === "done"', undefined, { timeout: 10_000 });
    await settle(300);
    expect(hitsOn(A, '/ok.png')).toBe(okBefore + 1);
    expect(F.hits).toHaveLength(0);
    expect(events.some((e) => e.kind === 'blocked' && e.url.startsWith(`${f}/fetch-redir`))).toBe(true);
  });

  it('iframe、重定向 iframe 与跨站 OOPIF 内的请求：禁止服务 0 次访问，OOPIF 确实加载', async () => {
    const childBefore = hitsOn(C, '/child');
    await page.goto(`${a}/iframes`);
    await settle(2000);
    expect(hitsOn(C, '/child')).toBe(childBefore + 1);
    expect(page.frames().some((fr) => fr.url().startsWith(`${c}/child`))).toBe(true);
    expect(events.some((e) => e.targetType === 'iframe' && e.url.startsWith(`${f}/oopif`) && e.kind === 'blocked')).toBe(true);
    expect(F.hits).toHaveLength(0);
  });

  it('弹出窗口首个请求（直接、重定向、noopener、链接 target=_blank）：禁止服务 0 次访问，允许弹窗正常加载', async () => {
    const okBefore = hitsOn(A, '/popup-ok');
    await page.goto(`${a}/popups`);
    await page.click('#l');
    await settle(2500);
    expect(hitsOn(A, '/popup-ok')).toBe(okBefore + 1);
    expect(F.hits).toHaveLength(0);
    expect(session.mux.resumeLog.every((r) => r.guarded)).toBe(true);
  });

  it('dedicated worker 内 fetch/importScripts：禁止服务 0 次访问，允许请求正常', async () => {
    const before = hitsOn(A, '/worker-ok');
    await page.goto(`${a}/worker`);
    await settle(2000);
    expect(hitsOn(A, '/worker.js')).toBeGreaterThan(0);
    expect(hitsOn(A, '/worker-ok')).toBe(before + 1);
    expect(F.hits).toHaveLength(0);
  });

  it('Service Worker 注册被阻断：脚本请求未到达服务端', async () => {
    await page.goto(`${a}/sw`);
    await settle(2000);
    expect(A.hits.filter((h) => h.path === '/sw.js')).toHaveLength(0);
    expect(F.hits).toHaveLength(0);
  });

  it('spawn 失败及时拒绝且清理代理，不等待不存在的 exit', async () => {
    await expect(launchGuardedChromium({ allowedHosts: [], userDataDir: path.join(root, 'missing-profile'), executablePath: path.join(root, '不存在.exe'), guard: { decide: () => ({ allow: false, reason: '测试' }) } })).rejects.toThrow();
  }, 4000);

  it.each(['--disable-features=WebTransport', '--disable-blink-features=WebTransport'])('WebTransport 开关对照：%s 必须不可用或同步拒绝', async (flag) => {
    const b = await chromium.launch({ headless: true, args: [flag] });
    try {
      const p = await b.newPage(); await p.goto(a);
      expect(await p.evaluate('isSecureContext')).toBe(true);
      const state = await p.evaluate(`(() => {
        if (typeof WebTransport === 'undefined') return '不可用';
        try { const t = new WebTransport('https://127.0.0.1:4443/'); t.ready.catch(() => {}); t.closed.catch(() => {}); t.close(); return '仍可构造'; }
        catch { return '同步拒绝'; }
      })()`);
      console.log('[WT 开关对照]', flag, state); expect(state).not.toBe('仍可构造');
    } finally { await b.close(); }
  });

  it('安全 loopback 上 WebTransport 不可用或构造同步拒绝', async () => {
    const p = await session.browser.newPage();
    try {
      await p.goto(a);
      expect(await p.evaluate('isSecureContext')).toBe(true);
      const result = await p.evaluate(`(() => {
        if (typeof WebTransport === 'undefined') return '不可用';
        try { const t = new WebTransport('https://127.0.0.1:4443/'); t.ready.catch(() => {}); t.closed.catch(() => {}); t.close(); return '仍可构造'; }
        catch { return '同步拒绝'; }
      })()`);
      console.log('[WT 实测]', session.browser.version(), result);
      expect(result).not.toBe('仍可构造');
    } finally { await p.close(); }
  });

  it('WebRTC 无防护对照有效；受控浏览器 UDP/STUN 与 TCP/TURN 均零到达', async () => {
    const udp = createSocket('udp4'); let udpCount = 0, tcpCount = 0;
    udp.on('message', () => udpCount++);
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
    const sockets = new Set<Socket>();
    const tcp = tcpServer((s) => { tcpCount++; sockets.add(s); s.on('data', () => {}); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    const ports = { udp: udp.address().port, tcp: (tcp.address() as { port: number }).port };
    const attempt = async (p: Page) => p.evaluate(`(async ({ udp, tcp }) => {
      const pcs = [];
      try {
        for (const server of [{ urls: 'stun:127.0.0.1:' + udp }, { urls: 'turn:127.0.0.1:' + tcp + '?transport=tcp', username: 'test', credential: 'test' }]) {
          const pc = new RTCPeerConnection({ iceServers: [server] }); pcs.push(pc); pc.createDataChannel('test'); await pc.setLocalDescription(await pc.createOffer());
        }
        await new Promise((r) => setTimeout(r, 2500)); return '已尝试';
      } catch { return '不可用或拒绝'; }
      finally { pcs.forEach((pc) => pc.close()); }
    })(${JSON.stringify(ports)})`);
    const control = await chromium.launch({ headless: true });
    try {
      const p = await control.newPage(); await p.goto(a); await attempt(p);
      console.log('[RTC 对照]', JSON.stringify({ udpCount, tcpCount }));
      expect(udpCount).toBeGreaterThan(0); expect(tcpCount).toBeGreaterThan(0);
      await control.close(); udpCount = 0; tcpCount = 0;
      const guarded = await session.browser.newPage();
      try { await guarded.goto(a); const state = await attempt(guarded); console.log('[RTC 受控]', JSON.stringify({ state, udpCount, tcpCount })); }
      finally { await guarded.close(); }
      expect(udpCount).toBe(0); expect(tcpCount).toBe(0);
    } finally {
      await control.close(); for (const s of sockets) s.destroy();
      await new Promise<void>((r) => tcp.close(() => r())); await new Promise<void>((r) => udp.close(r));
    }
  });

  it('WebSocket 按 host:port 准入：禁止主机零握手，允许主机确实到达', async () => {
    await page.goto(`${a}/ws`);
    await settle(2000);
    expect(F.upgrades).toHaveLength(0);
    expect(A.upgrades).toContain('/ws-allowed-host');
    expect(F.connections).toBe(0);
    console.log('[WS 实测]', JSON.stringify({ forbiddenTcp: F.connections, forbiddenUpgrades: F.upgrades.length, allowedUpgrades: A.upgrades.length }));
  });

  it('noopener 弹窗首屏立即发起 WebSocket：upgrade 计数 0', async () => {
    await page.goto(`${a}/ws-popup`);
    await settle(2500);
    expect(hitsOn(A, '/ws-immediate')).toBe(1);
    expect(F.upgrades).toHaveLength(0);
  });

  it('表单 POST 导航与 location 跳转到禁止服务：0 次访问', async () => {
    await page.goto(`${a}/navs`);
    await expectErrorCommit(page, () => page.evaluate('document.getElementById("fm").submit()').catch(() => {}));
    await page.goto(`${a}/navs`);
    await expectErrorCommit(page, () => page.evaluate(`location.href = '${f}/location'`).catch(() => {}));
    expect(F.hits).toHaveLength(0);
    expect(events.some((e) => e.kind === 'blocked' && e.method === 'POST' && e.url === `${f}/form-post`)).toBe(true);
    expect(events.some((e) => e.kind === 'blocked' && e.url === `${f}/location`)).toBe(true);
  });

  it('浏览器正文按 RequestPolicy 校验：正常 JSON POST 放行，方法覆盖/multipart/禁止路径不发出', async () => {
    await page.goto(`${a}/post`);
    await page.waitForFunction('document.title === "done"', undefined, { timeout: 10_000 });
    await settle(300);
    expect(A.hits.filter((h) => h.path === '/api/ok' && h.method === 'POST')).toHaveLength(1);
    for (const p of ['/api/override', '/api/override-header', '/api/multipart', '/api/forbidden-write']) expect(A.hits.filter((h) => h.path === p)).toHaveLength(0);
  });

  it('下载：禁止服务 0 次访问；允许的下载请求经过策略但不落盘', async () => {
    await page.goto(`${a}/download`);
    // 用 dispatch 触发点击，避免 Playwright click 等待被拒绝下载引发的导航
    await page.evaluate('document.getElementById("d1").click()').catch(() => {});
    await settle(1000);
    await page.goto(`${a}/download`);
    const before = A.hits.filter((h) => h.path === '/file.bin').length;
    await page.evaluate('document.getElementById("d2").click()').catch(() => {});
    await settle(1000);
    expect(A.hits.filter((h) => h.path === '/file.bin').length).toBe(before + 1);
    expect(session.mux.isClosed).toBe(false);
    expect(F.hits).toHaveLength(0);
    expect(events.some((e) => e.kind === 'blocked' && e.url === `${f}/file.bin`)).toBe(true);
    expect(events.some((e) => e.kind === 'allowed' && e.url === `${a}/file.bin`)).toBe(true);
  });

  it('关闭后浏览器进程树退出，无残留 Chromium 进程使用本次 profile', async () => {
    const pid = session.process.pid!;
    await Promise.all([session.close(), session.close()]);
    expect(session.fatalReason).toBeUndefined();
    expect(session.process.exitCode !== null || session.process.signalCode !== null).toBe(true);
    if (process.platform === 'win32') {
      const out = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*${root.replace(/'/g, "''")}*' } | Measure-Object | Select-Object -ExpandProperty Count`], { encoding: 'utf8' }).stdout.trim();
      expect(out).toBe('0');
    }
    expect(pid).toBeGreaterThan(0);
  });
});
