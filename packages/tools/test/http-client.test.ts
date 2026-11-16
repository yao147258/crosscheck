import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, GuardrailsSchema } from '../../core/src/index';
import { createEvidenceRedactor, EvidenceStore } from '../src/index';
import { RequestPolicy } from '../src/network/policy';
import { createHttpTools } from '../src/http/tools';
import { HttpClient } from '../src/network/http-client';

let a: Server, b: Server, base: string, target: string, root: string;
let targetHits = 0; let lastAuth: string | undefined; let lastHeaders: import('node:http').IncomingHttpHeaders = {}; let lastMethod = ''; let closed = false;
const meta = { actionId: 'a-1', phase: 'execution' as const };
beforeAll(async () => {
  b = createServer((req, res) => { targetHits++; lastHeaders = req.headers; lastAuth = req.headers.authorization; lastMethod = req.method ?? ''; res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  await new Promise<void>(resolve => b.listen(0, '127.0.0.1', resolve));
  target = `http://127.0.0.1:${(b.address() as {port:number}).port}`;
  a = createServer((req, res) => {
    const u = new URL(req.url!, 'http://localhost');
    if (u.pathname === '/redirect') { res.writeHead(Number(u.searchParams.get('status')), { location: u.searchParams.get('to')! }); res.end(); }
    else if (u.pathname === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); }
    else if (u.pathname === '/large') { res.end('a'.repeat(1024)); }
    else if (u.pathname === '/slow') { res.writeHead(200); res.write('a'); res.on('close', () => { closed = true; }); }
    else { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }
  });
  await new Promise<void>(resolve => a.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(a.address() as {port:number}).port}`;
  root = await mkdtemp(path.join(tmpdir(), 'http-test-'));
});
afterAll(async () => { a.closeAllConnections(); b.closeAllConnections(); await Promise.all([new Promise<void>(r => a.close(() => r())), new Promise<void>(r => b.close(() => r()))]); await rm(root, { recursive: true, force: true }); });
function client(hosts: string[], maxBytes = 1024 * 1024) {
  const redactor = createEvidenceRedactor([], ['secret-value']);
  return new HttpClient(new RequestPolicy(GuardrailsSchema.parse({ allowedHosts: hosts })), new EvidenceStore(new ArtifactStore(root), { runId:'run-1', caseId:'M-TC-1', attempt:1 }, redactor), redactor, { maxBytes });
}
function host(url: string) { return new URL(url).host; }
describe('真实 loopback HTTP 边界', () => {
  it.each([301,302,303,307,308])('%i 跳转到未授权服务前阻断', async status => {
    const before = targetHits;
    await expect(client([host(base)]).request({ url: `${base}/redirect?status=${status}&to=${encodeURIComponent(target)}`, method: 'POST', headers: [['content-type','application/json']], body:'{}' }, meta)).rejects.toThrow();
    expect(targetHits).toBe(before);
  });
  it.each([[301,'GET'],[302,'GET'],[303,'GET'],[307,'POST'],[308,'POST']])('%i 跨源跳转剥离认证并使用正确方法', async (status, method) => {
    const result = await client([host(base), host(target)]).request({ url: `${base}/redirect?status=${status}&to=${encodeURIComponent(target)}`, method:'POST', headers:[['content-type','application/json']], body:'{}' }, meta, [['Authorization','secret-value']]);
    expect(lastAuth).toBeUndefined(); expect(lastMethod).toBe(method); expect(result.evidenceIds.length).toBe(2); expect(JSON.stringify(result)).not.toContain('secret-value');
  });
  it('跨源剥离宿主注入的所有认证头且仍访问目标', async () => {
    const before = targetHits;
    await client([host(base), host(target)]).request({url:`${base}/redirect?status=302&to=${encodeURIComponent(target)}`}, meta, [['Authorization','secret-value'], ['cOoKiE','sid=secret-value'], ['Proxy-Authorization','secret-value'], ['X-API-Key','secret-value'], ['x-CuStOm-AuTh','secret-value']]);
    expect(targetHits).toBe(before + 1);
    for (const name of ['authorization','cookie','proxy-authorization','x-api-key','x-custom-auth']) expect(lastHeaders[name]).toBeUndefined();
  });
  it('策略拒绝登记未发送的 blocked 事件', async () => {
    const failure = await client([host(base)]).request({ url:target }, meta).catch(e => e);
    expect(failure.evidenceIds).toHaveLength(1);
    const artifacts = new ArtifactStore(root);
    const index = JSON.parse((await artifacts.readBytes('runs/run-1/cases/M-TC-1/attempts/1/evidence/index.json'))!.toString());
    const record = index.find((r:{id:string}) => r.id === failure.evidenceIds[0]);
    const data = JSON.parse((await artifacts.readBytes(record.path))!.toString());
    expect(data.log.entries[0].failure.kind).toBe('blocked');
    expect(data.log.entries[0].response.status).toBe(0);
  });
  it('模型输入拒绝先写未发送证据且不泄漏输入或访问目标', async () => {
    const before = targetHits;
    const c = client([host(target)]);
    let metaCalls = 0;
    const [tool] = createHttpTools(c, () => { metaCalls++; return meta; });
    const result = await tool!.execute({url:`${target}/?token=secret-value`}, {signal:new AbortController().signal}) as {evidenceIds:string[]};
    expect(targetHits).toBe(before);
    expect(metaCalls).toBe(1);
    expect(result.evidenceIds).toHaveLength(1);
    const artifacts = new ArtifactStore(root);
    const index = JSON.parse((await artifacts.readBytes('runs/run-1/cases/M-TC-1/attempts/1/evidence/index.json'))!.toString());
    const record = index.find((r:{id:string}) => r.id === result.evidenceIds[0]);
    const raw = (await artifacts.readBytes(record.path))!.toString();
    expect(raw).not.toContain('secret-value');
    expect(JSON.parse(raw).log.entries[0].failure).toMatchObject({kind:'blocked', sent:false, stage:'validation'});
  });
  it('模型输入拒绝时证据保存失败原样传播', async () => {
    const redactor = createEvidenceRedactor();
    const store = new EvidenceStore(new ArtifactStore(root), {runId:'run-1',caseId:'M-TC-1',attempt:1}, redactor);
    const failure = new Error('disk-failure');
    store.saveHar = async () => { throw failure; };
    const [tool] = createHttpTools(new HttpClient(new RequestPolicy(GuardrailsSchema.parse({allowedHosts:[host(base)]})), store, redactor), () => meta);
    await expect(tool!.execute({url:`${base}/?token=secret`}, {signal:new AbortController().signal})).rejects.toBe(failure);
  });
  it('采证失败传播宿主错误而非伪装网络失败', async () => {
    const redactor = createEvidenceRedactor();
    const store = new EvidenceStore(new ArtifactStore(root), { runId:'run-1', caseId:'M-TC-1', attempt:1 }, redactor);
    store.saveHar = async () => { throw new Error('disk-failure'); };
    const c = new HttpClient(new RequestPolicy(GuardrailsSchema.parse({ allowedHosts:[host(base)] })), store, redactor);
    await expect(c.request({url:base}, meta)).rejects.toThrow('disk-failure');
  });
  it('网络失败的证据及错误不暴露原始异常', async () => {
    const redactor = createEvidenceRedactor([], ['secret-value']);
    const store = new EvidenceStore(new ArtifactStore(root), { runId:'run-1', caseId:'M-TC-1', attempt:1 }, redactor);
    const c = new HttpClient(new RequestPolicy(GuardrailsSchema.parse({ allowedHosts:[host(base)] })), store, redactor, { transport: async () => { throw new Error('secret-value unknown-secret'); } });
    const error = await c.request({ url:`${base}/` }, meta).catch(e => e);
    expect(error.evidenceIds).toHaveLength(1);
    expect(JSON.stringify(error)).not.toMatch(/secret-value|unknown-secret/);
    expect(error.message).not.toMatch(/secret-value|unknown-secret/);
  });
  it('处理相对重定向，拒绝循环和过大响应', async () => {
    const c = client([host(base)], 100);
    const result = await c.request({ url:`${base}/redirect?status=302&to=%2Fok` }, meta);
    expect(result.evidenceIds).toHaveLength(2);
    await expect(c.request({ url:`${base}/loop` }, meta)).rejects.toThrow();
    await expect(c.request({ url:`${base}/large` }, meta)).rejects.toThrow();
  });
  it('超限响应先保存明确截断的网络证据', async () => {
    const artifacts = new ArtifactStore(root);
    const prefix = 'runs/run-1/cases/M-TC-1/attempts/1/evidence/index.json';
    const before = await artifacts.readBytes(prefix);
    const failure = await client([host(base)], 100).request({ url:`${base}/large` }, meta).catch(e => e);
    expect(failure.evidenceIds).toHaveLength(1);
    const after = await artifacts.readBytes(prefix);
    expect(after!.length).toBeGreaterThan(before?.length ?? 0);
    const records = JSON.parse(after!.toString());
    const data = await artifacts.readBytes(records.at(-1).path);
    const content = JSON.parse(data!.toString()).log.entries[0].response.content;
    expect(content).toMatchObject({ omitted: true, truncated: true });
    expect(failure.evidenceIds[0]).toBe(records.at(-1).id);
  });
  it('取消中断实际响应流', async () => {
    closed = false; const controller = new AbortController();
    const pending = client([host(base)]).request({ url:`${base}/slow`, signal: controller.signal }, meta);
    setTimeout(() => controller.abort(), 100);
    const failure = await pending.catch(e => e);
    expect(failure.evidenceIds).toHaveLength(1);
    const artifacts = new ArtifactStore(root);
    const index = JSON.parse((await artifacts.readBytes('runs/run-1/cases/M-TC-1/attempts/1/evidence/index.json'))!.toString());
    const record = index.find((r: {id:string}) => r.id === failure.evidenceIds[0]);
    const saved = JSON.parse((await artifacts.readBytes(record.path))!.toString());
    expect(saved.log.entries[0].response.status).toBe(0);
    expect(saved.log.entries[0].failure.kind).toBe('cancelled');
    for (let i=0; i<30 && !closed; i++) await new Promise(r => setTimeout(r, 10));
    expect(closed).toBe(true);
  });
});
