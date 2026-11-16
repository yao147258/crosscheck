/**
 * 假 CDP 通道测试（mock，非真实浏览器）：只验证多路复用器的消息顺序、ID 隔离与 fail-closed 逻辑，
 * 不能作为“请求在发送前被阻断”的安全证据；该证据见 browser-admission.real.test.ts。
 */
import { describe, expect, it, vi } from 'vitest';
import { GuardrailsSchema } from '../../core/src/index';
import { RequestPolicy } from '../src/network/policy';
import { GuardedCdpMux, policyDecider, type CdpChannel, type CdpMessage } from '../src/browser/request-guard';

class FakeChannel implements CdpChannel {
  sent: CdpMessage[] = [];
  closed = false;
  onmessage?: (m: CdpMessage) => void;
  onclose?: (r?: string) => void;
  send(m: CdpMessage) { this.sent.push(m); }
  close() { this.closed = true; }
  emit(m: CdpMessage) { this.onmessage?.(m); }
  last(method: string) { return [...this.sent].reverse().find((m) => m.method === method); }
  reply(m: CdpMessage | undefined, result: Record<string, unknown> = {}) { this.emit({ id: m!.id, result }); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const policy = new RequestPolicy(GuardrailsSchema.parse({ allowedHosts: ['127.0.0.1:1'] }));

function setup(timeout = 1000) {
  const channel = new FakeChannel();
  const fatal: string[] = [];
  const mux = new GuardedCdpMux(channel, { decide: policyDecider(policy), onFatal: (r) => fatal.push(r), commandTimeoutMs: timeout });
  const transport = mux.playwrightTransport();
  const toPw: CdpMessage[] = [];
  transport.onmessage = (m) => toPw.push(m as CdpMessage);
  return { channel, mux, transport, toPw, fatal };
}
const attach = (sessionId: string, type = 'page', waiting = true): CdpMessage => ({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { targetId: `t-${sessionId}`, type }, waitingForDebugger: waiting } });

describe('GuardedCdpMux（假通道）', () => {
  it('守卫安装完成前不向 Playwright 转发 attachedToTarget，后续消息保持顺序', async () => {
    const { channel, toPw } = setup();
    channel.emit(attach('s1'));
    channel.emit({ method: 'Page.lifecycleEvent', sessionId: 's1', params: {} });
    await tick();
    expect(toPw).toHaveLength(0);
    const fetch = channel.last('Fetch.enable')!;
    expect(fetch.sessionId).toBe('s1');
    expect(fetch.params).toEqual({ patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    channel.reply(fetch); await tick();
    expect(toPw).toHaveLength(0);
    channel.reply(channel.last('Target.setAutoAttach')); await tick();
    expect(toPw.map((m) => m.method)).toEqual(['Target.attachedToTarget', 'Page.lifecycleEvent']);
  });

  it('Playwright 消息 ID 与宿主命令隔离并原样映射回去', async () => {
    const { channel, transport, toPw } = setup();
    transport.send({ id: 1, method: 'Browser.getVersion', params: {} });
    const out = channel.last('Browser.getVersion')!;
    void transport;
    channel.emit({ id: out.id, result: { product: 'x' } }); await tick();
    expect(toPw).toEqual([{ id: 1, result: { product: 'x' } }]);
  });

  it('强制自动附着暂停与拒绝下载，拒绝 Playwright 使用 Fetch 域和改写阻断规则', async () => {
    const { channel, transport, toPw } = setup();
    transport.send({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
    expect(channel.last('Target.setAutoAttach')!.params).toMatchObject({ waitForDebuggerOnStart: true, autoAttach: true });
    transport.send({ id: 2, method: 'Browser.setDownloadBehavior', params: { behavior: 'allowAndName', downloadPath: 'C:/x' } });
    expect(channel.last('Browser.setDownloadBehavior')!.params).toEqual({ behavior: 'deny' });
    transport.send({ id: 3, method: 'Fetch.disable', params: {} });
    transport.send({ id: 4, method: 'Network.setBlockedURLs', params: { urls: [] } });
    await tick();
    expect(channel.last('Fetch.disable')).toBeUndefined();
    expect(toPw.filter((m) => m.error).map((m) => m.id)).toEqual([3, 4]);
  });

  it('Playwright 恢复未受守卫的 target 时 fail-closed', async () => {
    const { channel, transport, fatal } = setup();
    transport.send({ id: 1, method: 'Runtime.runIfWaitingForDebugger', sessionId: 'unknown', params: {} });
    expect(channel.last('Runtime.runIfWaitingForDebugger')).toBeUndefined();
    expect(fatal).toHaveLength(1);
    expect(channel.closed).toBe(true);
  });

  it('Service Worker 等不受支持的 target 不交给 Playwright 且被关闭', async () => {
    const { channel, toPw } = setup();
    channel.emit(attach('sw', 'service_worker'));
    await tick();
    channel.reply(channel.last('Fetch.enable')); await tick();
    expect(channel.last('Target.closeTarget')!.params).toEqual({ targetId: 't-sw' });
    channel.reply(channel.last('Target.closeTarget')); await tick();
    channel.emit({ method: 'Runtime.consoleAPICalled', sessionId: 'sw', params: {} }); await tick();
    expect(toPw).toHaveLength(0);
  });

  it('未暂停（已在运行）的 page 不能证明守卫先于请求：隐藏并关闭', async () => {
    const { channel, toPw, mux } = setup();
    channel.emit(attach('p', 'page', false)); await tick();
    channel.reply(channel.last('Fetch.enable')); await tick();
    expect(channel.last('Target.closeTarget')).toBeDefined();
    expect(toPw).toHaveLength(0);
    expect(mux.attachLog[0]).toEqual({ type: 'page', waiting: false, outcome: 'hidden' });
  });

  it('守卫安装失败或超时 fail-closed 并通知 Playwright 连接关闭', async () => {
    const { channel, fatal, transport } = setup(20);
    let closedReason: string | undefined;
    transport.onclose = (r) => { closedReason = r; };
    channel.emit(attach('s1')); await tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(fatal[0]).toMatch(/守卫安装失败/);
    expect(channel.closed).toBe(true);
    expect(closedReason).toBeDefined();
  });

  it('正常停止不报告 fatal，但仍关闭通道且幂等', () => {
    const { mux, channel, fatal } = setup();
    mux.shutdown('正常关闭', false); mux.shutdown('重复关闭', false);
    expect(channel.closed).toBe(true); expect(fatal).toHaveLength(0);
  });

  it('调试环境不能输出含凭证的原始 CDP 参数', () => {
    const { transport, channel } = setup();
    vi.stubEnv('CC_CDP_DEBUG', '1'); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      transport.send({ id: 1, method: 'Network.setExtraHTTPHeaders', params: { headers: { authorization: 'secret-test' } } });
      expect(channel.last('Network.setExtraHTTPHeaders')).toBeDefined(); expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); vi.unstubAllEnvs(); }
  });

  it('通道断开触发 fail-closed', () => {
    const { channel, fatal } = setup();
    channel.onclose?.('pipe 关闭');
    expect(fatal[0]).toMatch(/CDP 连接断开/);
  });

  it('Fetch.requestPaused 按策略放行/拒绝，正文来自 postDataEntries；无法取得正文时拒绝', async () => {
    const { channel } = setup();
    channel.emit(attach('s1')); await tick();
    for (const m of ['Fetch.enable', 'Target.setAutoAttach']) { channel.reply(channel.last(m)); await tick(); }
    const paused = (requestId: string, request: Record<string, unknown>) => channel.emit({ method: 'Fetch.requestPaused', sessionId: 's1', params: { requestId, resourceType: 'Fetch', request } });
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    paused('ok', { url: 'http://127.0.0.1:1/a', method: 'GET', headers: {} });
    paused('host', { url: 'http://127.0.0.1:2/a', method: 'GET', headers: {} });
    paused('json', { url: 'http://127.0.0.1:1/a', method: 'POST', headers: { 'Content-Type': 'application/json' }, hasPostData: true, postDataEntries: [{ bytes: b64('{"a":1}') }] });
    paused('override', { url: 'http://127.0.0.1:1/a', method: 'POST', headers: { 'Content-Type': 'application/json' }, hasPostData: true, postDataEntries: [{ bytes: b64('{"_method":"DELETE"}') }] });
    paused('nobody', { url: 'http://127.0.0.1:1/a', method: 'POST', headers: { 'Content-Type': 'application/json' }, hasPostData: true });
    paused('sw', { url: 'http://127.0.0.1:1/sw.js', method: 'GET', headers: { 'Service-Worker': 'script' } });
    const decided = (id: string) => channel.sent.find((m) => (m.method === 'Fetch.continueRequest' || m.method === 'Fetch.failRequest') && m.params?.requestId === id)?.method;
    expect(decided('ok')).toBe('Fetch.continueRequest');
    expect(decided('json')).toBe('Fetch.continueRequest');
    for (const id of ['host', 'override', 'nobody', 'sw']) expect(decided(id)).toBe('Fetch.failRequest');
  });

  it('来自未知 session 的暂停请求一律拒绝', () => {
    const { channel } = setup();
    channel.emit({ method: 'Fetch.requestPaused', sessionId: 'ghost', params: { requestId: 'r', resourceType: 'Document', request: { url: 'http://127.0.0.1:1/', method: 'GET', headers: {} } } });
    expect(channel.last('Fetch.failRequest')!.params).toMatchObject({ requestId: 'r' });
  });
});
