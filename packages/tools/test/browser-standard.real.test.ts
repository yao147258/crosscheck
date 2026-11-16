import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, EvidenceRecordSchema } from '@crosscheck/core';
import * as tools from '../src/index';
import { capturePage } from '../src/browser/capture';

// 独立解码 PNG 像素，不能把压缩字节不含明文当作遮罩证明。
function pixel(png: Buffer, x: number, y: number): number[] {
  let offset = 8, width = 0, channels = 0; const chunks: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), tag = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (tag === 'IHDR') { width = data.readUInt32BE(0); expect(data[8]).toBe(8); channels = data[9] === 6 ? 4 : 3; }
    if (tag === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels; let prev = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const filter = raw[row * (stride + 1)]!, line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0, b = prev[i]!, c = i >= channels ? prev[i - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[i] = (line[i]! + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
    prev = line;
  }
  return [...prev.subarray(x * channels, x * channels + 3)];
}
const secret = 'BROWSER_SENTINEL_7368';
const skip = process.env.CROSSCHECK_REAL_BROWSER !== '1';
let server: Server, external: Server, baseURL: string, externalURL: string, hits = 0;
async function listen(s: Server) { await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(s.address() as { port: number }).port}`; }
beforeAll(async () => {
  if (skip) return;
  external = createServer((_req, res) => { hits++; res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, password: secret })); });
  externalURL = await listen(external);
  server = createServer((req, res) => {
    if (req.url === '/download') { res.setHeader('Content-Disposition', 'attachment; filename="test.txt"'); res.end('download'); return; }
    if (req.url === '/binary') { res.setHeader('Content-Type', 'application/octet-stream'); res.end(secret); return; }
    if (req.url === '/huge') { res.setHeader('Content-Type', 'text/plain'); res.end('x'.repeat(300000)); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><style>body{margin:0}#mask,#known,canvas,svg,iframe{position:absolute;left:20px;width:140px;height:30px;background:rgb(0,200,0)}#mask{top:20px}#known{top:60px}canvas{top:100px}svg{top:140px}iframe{top:180px}form{margin-top:230px}</style>
<div id="mask">APPROVED_SENTINEL</div><div id="known">${secret}</div><canvas></canvas><svg></svg><iframe srcdoc="private"></iframe>
<form onsubmit="event.preventDefault(); document.querySelector('#result').textContent='已保存'; console.log(document.querySelector('#password').value); fetch('${externalURL}/save?token='+document.querySelector('#password').value)">
<input id="password" type="password" name="password" style="width:160px;height:30px" value="UNKNOWN_PASSWORD"><input data-testid="name" aria-label="名称"><select id="choice"><option value="a">甲</option><option value="b">乙</option></select><button>保存</button></form><p id="result">等待</p>
<script>fetch('${externalURL}/initial').then(r=>r.json()).then(()=>console.log('网络成功'));fetch('/binary');fetch('/huge');fetch('http://127.0.0.1:1/fail').catch(()=>{}); console.log('${secret}');</script>`);
  }); baseURL = await listen(server);
});
afterAll(async () => { if (skip) return; await Promise.all([server, external].map(s => new Promise<void>((resolve, reject) => { s.closeAllConnections(); s.close(e => e ? reject(e) : resolve()); }))); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'cc-browser-real-')), artifacts = new ArtifactStore(root), redactor = tools.createEvidenceRedactor([], [secret]);
  const store = new tools.EvidenceStore(artifacts, { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 }, redactor);
  const host = new tools.BrowserHost({ baseURL, evidence: store, redactor, screenshotMasks: ['#mask'], env: { TEST_PASSWORD: secret } });
  let n = 0;
  return { root, artifacts, store, host, signal: new AbortController().signal, meta: () => ({ actionId: `a-${++n}`, phase: 'execution' as const }), index: () => artifacts.readJson('runs/run-1/cases/M-TC-1/attempts/1/evidence/index.json', EvidenceRecordSchema.array()) };
}
describe.skipIf(skip)('标准 Playwright 真实表单与可信采证', () => {
  it('R1–R3 子树秘密、无盒子宿主、私密后代和语义字段共同遮罩且不遮安全区域', async () => {
    const s = await setup();
    try {
      const session = await s.host.getSession(s.signal);
      await session.page.setContent(`<style>body{margin:0}section{height:40px;width:500px;background:#00cc00}x-private{display:contents}</style>
<section><span>BROWSER_</span><span>SENTINEL_7368</span></section>
<section><span style="display:contents">${secret}</span></section>
<section><svg width="400" height="35"><text x="0" y="20">SVG_PRIVATE</text></svg></section>
<section><x-private><span>CUSTOM_PRIVATE</span></x-private></section>
<section>https://example.test/?token=DYNAMIC_PRIVATE</section>
<section><span>{"password":"</span><span>JSON_PRIVATE"}</span></section>
<section id="safe">可见安全内容</section>`);
      const observed = await capturePage(session.page, tools.createEvidenceRedactor([], [secret]));
      const clean = JSON.stringify(tools.sanitizeDom(observed.dom, tools.createEvidenceRedactor([], [secret])));
      expect(clean).not.toMatch(/BROWSER_|SENTINEL_7368|SVG_PRIVATE|CUSTOM_PRIVATE|DYNAMIC_PRIVATE|JSON_PRIVATE/);
      expect(clean).toContain('可见安全内容');
      const r = tools.createEvidenceRedactor([], [secret]);
      const evidence = new tools.EvidenceStore(s.artifacts, { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 }, r);
      const captured = await capturePage(session.page, r);
      const record = await evidence.saveScreenshot(captured.screenshot, s.meta());
      const png = (await evidence.readScreenshotEvidence(record.id)).bytes;
      for (const y of [5, 45, 85, 125, 165, 205]) expect(pixel(png, 5, y)).toEqual([255, 0, 255]);
      expect(pixel(png, 490, 265)).toEqual([0, 204, 0]);
    } finally { await s.host.close(); await rm(s.root, { recursive: true, force: true }); }
  });
  it.each(['F1', 'F2'])('%s 无盒子溢出与隐藏祖先的可见秘密字形不进入截图，安全邻居不变', async scenario => {
    const s = await setup();
    try {
      const session = await s.host.getSession(s.signal);
      const content = scenario === 'F1'
        ? `<div style="width:1px;height:1px;overflow:visible"><span style="display:contents">${secret}</span></div>`
        : `<div style="visibility:hidden"><span style="visibility:visible">${secret}</span></div>`;
      await session.page.setContent(`<style>body{margin:0;background:white;color:black;font:24px monospace}#safe{position:absolute;top:100px;width:500px;height:40px;background:#00cc00}</style>${content}<div id="safe">安全邻居</div>`);
      // 原始 PNG 只在内存定位真实字形像素，不落盘；断言覆盖祖先 1px 框以外的文字。
      const baseline = await session.page.screenshot();
      const ink: [number, number][] = [];
      for (let y = 4; y < 28; y += 6) for (let x = 10; x < 280; x += 4) if (pixel(baseline, x, y).every(c => c < 80)) ink.push([x, y]);
      expect(ink.length).toBeGreaterThan(10);
      const r = tools.createEvidenceRedactor([], [secret]);
      const store = new tools.EvidenceStore(s.artifacts, { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 }, r);
      const captured = await capturePage(session.page, r);
      const dom = await store.readTextEvidence((await store.saveDom(captured.dom, s.meta())).id);
      expect(dom.text).not.toContain(secret); expect(dom.text).toContain('安全邻居');
      const png = (await store.readScreenshotEvidence((await store.saveScreenshot(captured.screenshot, s.meta())).id)).bytes;
      for (const [x, y] of ink) expect([[255, 255, 255], [255, 0, 255]]).toContainEqual(pixel(png, x, y));
      expect(pixel(png, 490, 110)).toEqual([0, 204, 0]);
      expect(await session.page.locator('span').evaluate(el => getComputedStyle(el).visibility)).toBe('visible');
    } finally { await s.host.close(); await rm(s.root, { recursive: true, force: true }); }
  }, 20000);
  it('R9 局部文本超限仅省略对应区域，证据明确不完整', async () => {
    const s = await setup();
    try {
      const session = await s.host.getSession(s.signal);
      await session.page.setContent(`<style>body{margin:0}div{height:40px;width:500px;background:#00cc00;overflow:hidden}</style><div>${'x'.repeat(2100)}</div><div>安全尾部</div>`);
      const r = tools.createEvidenceRedactor(), store = new tools.EvidenceStore(s.artifacts, { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 }, r);
      const captured = await capturePage(session.page, r);
      const dom = await store.readTextEvidence((await store.saveDom(captured.dom, s.meta())).id);
      expect(dom.sourceIncomplete).toBe(true); expect(dom.text).toContain('limit'); expect(dom.text).toContain('安全尾部'); expect(dom.text).not.toContain('x'.repeat(50));
      const png = (await store.readScreenshotEvidence((await store.saveScreenshot(captured.screenshot, s.meta())).id)).bytes;
      expect(pixel(png, 490, 5)).toEqual([255, 0, 255]); expect(pixel(png, 490, 45)).toEqual([0, 204, 0]);
    } finally { await s.host.close(); await rm(s.root, { recursive: true, force: true }); }
  });
  it('控件只隐藏值并保留完整结构；业务区域、批准遮罩与超限仍不完整', async () => {
    const s = await setup();
    try {
      const session = await s.host.getSession(s.signal);
      for (const [tail, incomplete] of [['', false], ['<img src="/image">', true], ['<canvas></canvas>', true], ['<div id="mask">遮罩</div>', true], ['<div id="mask"><input value="ANCESTOR_SENTINEL"></div>', true], [`<p>${'x'.repeat(2100)}</p>`, true]] as const) {
        await session.page.setContent(`<label>名称<input value="INPUT_VALUE_SENTINEL"></label><input type="password" name="password" value="PASSWORD_SENTINEL"><textarea>TEXTAREA_SENTINEL</textarea><select><option>OPTION_SENTINEL</option></select><p>保存成功</p>${tail}`);
        const captured = await capturePage(session.page, tools.createEvidenceRedactor(), ['#mask']);
        const record = await s.store.saveDom(captured.dom, s.meta());
        const dom = await s.store.readTextEvidence(record.id);
        expect(dom.sourceIncomplete).toBe(incomplete);
        if (!incomplete) { expect(dom.text).toContain('redacted-value'); expect(dom.text).toContain('locator'); expect(dom.text).toContain('保存成功'); }
        expect(dom.text).not.toMatch(/INPUT_VALUE_SENTINEL|PASSWORD_SENTINEL|TEXTAREA_SENTINEL|OPTION_SENTINEL/);
      }
      const forged = await s.store.saveDom([{ tag: 'div', sensitive: true, omissionReason: 'redacted-value' } as any, { tag: 'input', sensitive: true, omissionReason: 'redacted-value' } as any], s.meta());
      expect((await s.store.readTextEvidence(forged.id)).sourceIncomplete).toBe(true);
    } finally { await s.host.close(); await rm(s.root, { recursive: true, force: true }); }
  });
  it('每个宿主的 context 独立，不共享 Cookie，禁止自动下载', async () => {
    const s = await setup(), t = await setup();
    try {
      const first = await s.host.getSession(s.signal), second = await t.host.getSession(t.signal);
      await first.context.addCookies([{ name: 'actor', value: 'one', url: baseURL }]);
      expect(await second.context.cookies()).toEqual([]);
      const waiting = first.page.waitForEvent('download');
      await first.page.goto(`${baseURL}/download`).catch(() => {});
      const download = await waiting; expect(await download.failure()).toMatch(/acceptDownloads/);
    } finally { await Promise.all([s.host.close(), t.host.close()]); await Promise.all([s.root, t.root].map(root => rm(root, { recursive: true, force: true }))); }
  });
  it('已取消的动作不启动会话，不合法导航和缺失定位器不产生页面副作用', async () => {
    const s = await setup();
    try {
      for (const url of ['file:///private', 'javascript:alert(1)', 'data:text/html,x']) await expect(s.host.perform({ kind: 'navigate', url }, s.meta(), s.signal)).rejects.toMatchObject({ kind: 'blocked' });
      await expect(s.host.perform({ kind: 'click' } as tools.BrowserAction, s.meta(), s.signal)).rejects.toMatchObject({ kind: 'blocked' });
      const controller = new AbortController(); controller.abort();
      await expect(s.host.perform({ kind: 'observe' }, s.meta(), controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
      expect(await s.index()).toBeUndefined();
    } finally { await s.host.close(); await rm(s.root, { recursive: true, force: true }); }
  });
  it('已有会话收到预取消信号仍先关闭资源，未命中定位器保留前后观察', async () => {
    const s = await setup();
    try {
      await s.host.perform({ kind: 'navigate', url: '/' }, s.meta(), s.signal);
      await expect(s.host.perform({ kind: 'click', locator: { strategy: 'css', value: '#missing' } }, s.meta(), s.signal)).rejects.toMatchObject({ kind: 'browser' });
      expect((await s.index())!.filter(e => e.actionId === 'a-2')).toHaveLength(6);
      const session = await s.host.getSession(s.signal), controller = new AbortController(); controller.abort();
      await expect(s.host.perform({ kind: 'observe' }, s.meta(), controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
      expect(session.page.isClosed()).toBe(true); expect(session.browser.isConnected()).toBe(false);
    } finally { await s.host.close(); await rm(s.root, { recursive: true, force: true }); }
  }, 20000);
  it('前置采证期间取消也等待浏览器完全关闭', async () => {
    const s = await setup(), controller = new AbortController();
    try {
      const session = await s.host.getSession(s.signal);
      const waiting = s.host.perform({ kind: 'observe' }, s.meta(), controller.signal);
      const result = expect(waiting).rejects.toMatchObject({ kind: 'cancelled' });
      setTimeout(() => controller.abort(), 1);
      await result;
      expect(session.page.isClosed()).toBe(true); expect(session.browser.isConnected()).toBe(false);
    } finally { await s.host.close(); await rm(s.root, { recursive: true, force: true }); }
  });
  it('存储故障原样拒绝，不能被工具包装成业务失败', async () => {
    const s = await setup();
    try {
      const failure = new Error('测试磁盘故障');
      vi.spyOn(s.store, 'saveDom').mockRejectedValue(failure);
      await expect(s.host.perform({ kind: 'navigate', url: '/' }, s.meta(), s.signal)).rejects.toBe(failure);
    } finally { vi.restoreAllMocks(); await s.host.close(); await rm(s.root, { recursive: true, force: true }); }
  });
  it('事件超限明确标注省略，flush 写盘期间的新事件不会丢失', async () => {
    const s = await setup();
    try {
      const session = await s.host.getSession(s.signal);
      const original = s.store.saveHar.bind(s.store); let injected = false;
      vi.spyOn(s.store, 'saveHar').mockImplementation(async (...args) => {
        if (!injected) { injected = true; await session.page.evaluate(() => console.log('FLUSH_PENDING_EVENT')); }
        return original(...args);
      });
      await s.host.perform({ kind: 'observe' }, s.meta(), s.signal);
      await s.host.perform({ kind: 'observe' }, s.meta(), s.signal);
      await session.page.evaluate(async url => { for (let i = 0; i < 250; i++) console.log('bounded', i); await Promise.all(Array.from({ length: 220 }, (_, i) => fetch(`${url}/bounded?i=${i}`))); }, externalURL);
      await s.host.perform({ kind: 'observe' }, s.meta(), s.signal);
      const records = (await s.index())!;
      const logs = await Promise.all(records.filter(e => e.type === 'console').map(e => s.store.readTextEvidence(e.id)));
      expect(logs.map(x => x.text).join('\n')).toContain('FLUSH_PENDING_EVENT');
      expect(logs.map(x => x.text).join('\n')).toMatch(/omitted: \d+ console events/);
      expect(logs.map(x => x.text).join('\n').length).toBeLessThan(12000);
      const network = await Promise.all(records.filter(e => e.type === 'network').map(e => s.store.readTextEvidence(e.id)));
      expect(network.map(x => x.text).join('\n')).toContain('事件限额');
      expect(network.every(x => JSON.parse(x.text).log.entries.length <= 201)).toBe(true);
    } finally { vi.restoreAllMocks(); await s.host.close(); await rm(s.root, { recursive: true, force: true }); }
  });
  it('全部动作、页面跨端口 fetch、内存遮罩像素及脱敏 DOM/console/HAR', async () => {
    expect(tools).toHaveProperty('BrowserHost');
    const s = await setup();
    try {
      const initialHits = hits;
      const nav = await s.host.perform({ kind: 'navigate', url: '/' }, s.meta(), s.signal);
      expect(nav.evidenceIds.length).toBeGreaterThanOrEqual(6);
      const session = await s.host.getSession(s.signal);
      await vi.waitFor(() => expect(hits).toBeGreaterThan(initialHits));
      const afterNav = (await s.index())!;
      const shot = afterNav.filter(e => e.type === 'screenshot').at(-1)!;
      const image = await s.store.readScreenshotEvidence(shot.id);
      for (const y of [25, 65, 105, 145, 185, 245]) expect(pixel(image.bytes, 25, y)).toEqual([255, 0, 255]);
      expect(pixel(image.bytes, 500, 30)).toEqual([255, 255, 255]);
      await s.host.perform({ kind: 'fill', locator: { strategy: 'css', value: '#password' }, env: 'TEST_PASSWORD' }, s.meta(), s.signal);
      await s.host.perform({ kind: 'fill', locator: { strategy: 'testId', value: 'name' }, value: '测试名称' }, s.meta(), s.signal);
      await s.host.perform({ kind: 'select', locator: { strategy: 'xpath', value: '//select' }, values: ['b'] }, s.meta(), s.signal);
      await s.host.perform({ kind: 'press', locator: { strategy: 'css', value: '[data-testid=name]' }, key: 'End' }, s.meta(), s.signal);
      await s.host.perform({ kind: 'click', locator: { strategy: 'role', value: 'button', name: '保存' } }, s.meta(), s.signal);
      await s.host.perform({ kind: 'wait', locator: { strategy: 'text', value: '已保存' }, state: 'visible' }, s.meta(), s.signal);
      await s.host.perform({ kind: 'observe' }, s.meta(), s.signal);
      expect(await session.page.locator('#choice').inputValue()).toBe('b');
      expect(await session.page.locator('[data-testid=name]').inputValue()).toBe('测试名称');
      await s.host.close();
      const records = (await s.index())!; const texts = await Promise.all(records.filter(e => e.type !== 'screenshot').map(e => s.store.readTextEvidence(e.id)));
      const all = texts.map(t => t.text).join('\n');
      expect(all).toContain('已保存'); expect(all).toContain('网络成功'); expect(all).toContain('requestfailed'); expect(all).toContain('omitted');
      expect(all).not.toMatch(/BROWSER_SENTINEL_7368|UNKNOWN_PASSWORD|APPROVED_SENTINEL/);
      expect(all).toContain('[REDACTED]');
      expect(records.filter(e => e.actionId === 'a-2' && e.type === 'dom')).toHaveLength(2);
      const walk = async (dir: string): Promise<string> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(e => e.isDirectory() ? walk(path.join(dir, e.name)) : readFile(path.join(dir, e.name)).then(b => b.toString())))).join('');
      expect(await walk(path.join(s.root, '.crosscheck'))).not.toMatch(/BROWSER_SENTINEL_7368|UNKNOWN_PASSWORD|APPROVED_SENTINEL/);
      const other = new tools.EvidenceStore(s.artifacts, { runId: 'run-1', caseId: 'M-TC-2', attempt: 1 }, tools.createEvidenceRedactor());
      await expect(other.readScreenshotEvidence(shot.id)).rejects.toThrow();
      await s.artifacts.remove(shot.path); await s.artifacts.publishExclusive(shot.path, Buffer.from('tampered'));
      await expect(s.store.readScreenshotEvidence(shot.id)).rejects.toThrow(/摘要/);
      await s.artifacts.remove(shot.path); await expect(s.store.readScreenshotEvidence(shot.id)).rejects.toThrow();
    } finally { await s.host.close(); await rm(s.root, { recursive: true, force: true }); }
  }, 60000);
  it('失败动作保留观察，取消等待并 await context/browser 关闭，关闭幂等', async () => {
    expect(tools).toHaveProperty('BrowserHost');
    const s = await setup(), controller = new AbortController();
    try {
      await s.host.perform({ kind: 'navigate', url: '/' }, s.meta(), s.signal);
      const session = await s.host.getSession(controller.signal);
      const waiting = s.host.perform({ kind: 'wait', locator: { strategy: 'css', value: '#never' }, state: 'visible' }, s.meta(), controller.signal);
      const result = expect(waiting).rejects.toMatchObject({ kind: 'cancelled' });
      setTimeout(() => controller.abort(), 300);
      await result; await s.host.close(); await s.host.close();
      expect(session.page.isClosed()).toBe(true); expect(session.browser.isConnected()).toBe(false);
      expect((await s.index())!.filter(e => e.actionId === 'a-2').length).toBeGreaterThanOrEqual(4);
    } finally { await s.host.close(); await rm(s.root, { recursive: true, force: true }); }
  }, 30000);
});
