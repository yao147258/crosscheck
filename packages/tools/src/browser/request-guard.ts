import type { ConnectOverCDPTransport } from 'playwright';
import type { RequestPolicy, HeaderPairs } from '../network/policy';

/**
 * CDP 协议封装集中在本文件：
 * - 宿主独占唯一一条到 Chromium 的 CDP 连接（--remote-debugging-pipe，不开放调试端口）；
 * - Playwright 只能经由 `playwrightTransport()` 使用同一连接，消息 ID 由本层重映射隔离；
 * - 每个自动附着的 target 必须先安装 Fetch 请求阶段守卫，之后才把 attachedToTarget 转发给 Playwright，
 *   因而 Playwright 不可能在守卫就绪前对该 target 发出 Runtime.runIfWaitingForDebugger；
 * - 任何守卫安装失败、超时或连接断开都 fail-closed：关闭浏览器，而不是继续放行。
 */

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

/** 原始 CDP 通道（由 session 层基于 pipe 实现，测试可注入假通道）。 */
export interface CdpChannel {
  send(message: CdpMessage): void;
  close(): void;
  onmessage?: (message: CdpMessage) => void;
  onclose?: (reason?: string) => void;
}

export interface PausedRequest {
  url: string;
  method: string;
  headers: HeaderPairs;
  /** undefined 表示无正文；Uint8Array 表示无法按文本验证的正文 */
  body?: string | Uint8Array;
  resourceType: string;
  targetType: string;
  /** 宿主无法取得完整正文时为 true，必须拒绝 */
  bodyUnavailable: boolean;
}

export type GuardDecision = { allow: true } | { allow: false; reason: string };

export interface GuardEvent {
  kind: 'allowed' | 'blocked';
  url: string;
  method: string;
  resourceType: string;
  targetType: string;
  reason?: string;
}

export interface GuardOptions {
  decide(request: PausedRequest): GuardDecision;
  /** 守卫自身发出的 CDP 命令超时（毫秒） */
  commandTimeoutMs?: number;
  /** 发生不可恢复的守卫故障时调用；调用方必须终止浏览器进程 */
  onFatal(reason: string): void | Promise<void>;
  onEvent?(event: GuardEvent): void;
}

/** 需要安装请求守卫后才可恢复的 target 类型；其余类型（含 service_worker）一律不交给 Playwright 且尝试关闭。 */
const GUARDED_TYPES = new Set(['page', 'iframe', 'worker']);

interface Pending { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface SessionInfo { targetId: string; type: string; guarded: boolean }

/** 将 RequestPolicy 应用于浏览器真实请求（含正文与方法覆盖检查）。 */
export function policyDecider(policy: RequestPolicy): (request: PausedRequest) => GuardDecision {
  return (request) => {
    if (request.bodyUnavailable) return { allow: false, reason: '无法取得请求正文' };
    // Service Worker 脚本抓取一律拒绝：不支持 Service Worker
    if (request.headers.some(([name, value]) => name.toLowerCase() === 'service-worker' && value.toLowerCase() === 'script')) return { allow: false, reason: '禁止 Service Worker' };
    const result = policy.check({ url: request.url, method: request.method, headers: request.headers, ...(request.body !== undefined ? { body: request.body } : {}) });
    return result.ok ? { allow: true } : { allow: false, reason: result.reason };
  };
}

function decodeBody(request: Record<string, unknown>): { body?: string | Uint8Array; unavailable: boolean } {
  if (request.hasPostData !== true) return { unavailable: false };
  const entries = request.postDataEntries;
  if (!Array.isArray(entries) || entries.length === 0) return { unavailable: true };
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = (entry as { bytes?: unknown }).bytes;
    // 缺失 bytes 的条目通常是文件/blob 引用，无法验证
    if (typeof bytes !== 'string') return { unavailable: true };
    chunks.push(Buffer.from(bytes, 'base64'));
  }
  const raw = Buffer.concat(chunks);
  try { return { body: new TextDecoder('utf-8', { fatal: true }).decode(raw), unavailable: false }; }
  catch { return { body: new Uint8Array(raw), unavailable: false }; }
}

export class GuardedCdpMux {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** 内部 ID → Playwright 原始 ID */
  private readonly pwIds = new Map<number, number>();
  private readonly sessions = new Map<string, SessionInfo>();
  /** 被拒绝交给 Playwright 的 session（未受支持类型或守卫失败） */
  private readonly hidden = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private shutdownPromise?: Promise<void>;
  /** 终止未确认时不能主动断管道；仅暴露固定安全原因，不包含回调异常内容。 */
  cleanupFailure?: string;
  private pwOnMessage?: (message: object) => void;
  private pwOnClose?: (reason?: string) => void;
  private readonly timeoutMs: number;
  /** 测试与审计用：发出 runIfWaitingForDebugger 时守卫是否已就绪 */
  readonly resumeLog: { sessionId: string; guarded: boolean; by: 'playwright' | 'guard' }[] = [];
  readonly attachLog: { type: string; waiting: boolean; outcome: 'guarded' | 'hidden' }[] = [];

  constructor(private readonly channel: CdpChannel, private readonly options: GuardOptions) {
    this.timeoutMs = options.commandTimeoutMs ?? 5000;
    channel.onmessage = (message) => this.receive(message);
    channel.onclose = (reason) => this.shutdown(`CDP 连接断开${reason ? `：${reason}` : ''}`);
  }

  /** 在 Playwright 连接之前调用：根级自动附着暂停、拒绝下载、根级请求守卫。 */
  async init(): Promise<void> {
    await this.command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await this.command('Browser.setDownloadBehavior', { behavior: 'deny' });
  }

  get isClosed(): boolean { return this.closed; }

  /** 宿主自身发出的 CDP 命令（不经过 Playwright）。 */
  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.channel.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  }

  /** 交给 Playwright connectOverCDP 的 transport；只允许创建一次。 */
  playwrightTransport(): ConnectOverCDPTransport {
    if (this.pwOnMessage) throw new Error('Playwright transport 只能创建一次');
    const mux = this;
    const transport: ConnectOverCDPTransport = {
      send(message: object) { mux.fromPlaywright(message as CdpMessage); },
      close() { mux.shutdown('Playwright 关闭连接'); },
    };
    // Playwright 在 connect 时设置 onmessage/onclose，这里用访问器捕获
    let onmessage: ((m: object) => void) | undefined; let onclose: ((r?: string) => void) | undefined;
    Object.defineProperty(transport, 'onmessage', { get: () => onmessage, set: (fn) => { onmessage = fn; mux.pwOnMessage = fn; }, enumerable: true });
    Object.defineProperty(transport, 'onclose', { get: () => onclose, set: (fn) => { onclose = fn; mux.pwOnClose = fn; }, enumerable: true });
    this.pwOnMessage = () => {};
    return transport;
  }

  shutdown(reason: string, fatal = true): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
    const disconnect = () => {
      try { this.channel.close(); } catch { /* 已物理断开 */ }
      const onclose = this.pwOnClose;
      this.pwOnClose = undefined;
      try { onclose?.(reason); } catch { /* 消费者异常不能逃逸清理 */ }
    };
    if (!fatal) { disconnect(); return this.shutdownPromise = Promise.resolve(); }
    // 同步停止转发，但只有 session 确认受控终止后才能主动断 pipe。
    // 回调失败意味着未能证明终止：保留 pipe，明确留下清理故障而非假成功。
    try {
      const confirmation = this.options.onFatal(reason);
      this.shutdownPromise = Promise.resolve(confirmation).then(disconnect, () => {
        this.cleanupFailure = '会话终止未确认，保留 CDP 管道';
      });
    } catch {
      this.cleanupFailure = '会话终止未确认，保留 CDP 管道';
      this.shutdownPromise = Promise.resolve();
    }
    return this.shutdownPromise;
  }

  private fatal(reason: string): void { this.shutdown(`请求守卫故障：${reason}`); }

  private fromPlaywright(message: CdpMessage): void {
    if (this.closed) return;
    const replyError = (text: string) => this.enqueue(() => this.toPlaywright({ id: message.id, error: { code: -32000, message: text }, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
    if (message.sessionId && this.hidden.has(message.sessionId)) return replyError('target 不受支持');
    let params = message.params ?? {};
    switch (message.method) {
      case 'Target.setAutoAttach':
        // 强制暂停新 target，保证守卫先于恢复
        params = { ...params, autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
        break;
      case 'Browser.setDownloadBehavior':
        params = { ...params, behavior: 'deny' };
        delete params.downloadPath;
        break;
      case 'Runtime.runIfWaitingForDebugger': {
        const info = message.sessionId ? this.sessions.get(message.sessionId) : undefined;
        if (message.sessionId && !info?.guarded) {
          // 理论上不可达：attachedToTarget 在守卫就绪前不会转发
          this.resumeLog.push({ sessionId: message.sessionId, guarded: false, by: 'playwright' });
          this.fatal('Playwright 试图恢复未受守卫的 target');
          return;
        }
        if (message.sessionId) this.resumeLog.push({ sessionId: message.sessionId, guarded: true, by: 'playwright' });
        break;
      }
      default:
        if (message.method?.startsWith('Fetch.')) return replyError('Fetch 域由宿主请求守卫独占');
        if (message.method === 'Network.setBlockedURLs' || message.method === 'Network.setBypassServiceWorker' && params.bypass !== true) return replyError('网络阻断规则由宿主独占');
    }
    const id = this.nextId++;
    if (message.id !== undefined) this.pwIds.set(id, message.id);
    this.channel.send({ ...message, id, params });
  }

  private receive(message: CdpMessage): void {
    if (this.closed) return;
    if (message.id !== undefined) {
      const own = this.pending.get(message.id);
      if (own) {
        this.pending.delete(message.id);
        clearTimeout(own.timer);
        if (message.error) own.reject(new Error(message.error.message ?? 'CDP 错误'));
        else own.resolve(message.result ?? {});
        return;
      }
      const pwId = this.pwIds.get(message.id);
      if (pwId === undefined) return;
      this.pwIds.delete(message.id);
      this.enqueue(() => this.toPlaywright({ ...message, id: pwId }));
      return;
    }
    if (message.method === 'Fetch.requestPaused') { this.onPaused(message); return; }
    if (message.method === 'Fetch.authRequired') { void this.command('Fetch.continueWithAuth', { requestId: message.params?.requestId, authChallengeResponse: { response: 'CancelAuth' } }, message.sessionId).catch(() => {}); return; }
    if (message.method === 'Target.attachedToTarget') {
      // 串行处理：守卫就绪前，后续所有发往 Playwright 的消息都排队，保持原始顺序
      this.enqueue(() => this.onAttached(message));
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      const child = message.params?.sessionId as string | undefined;
      if (child && this.hidden.has(child)) { this.hidden.delete(child); return; }
      if (child) this.sessions.delete(child);
    }
    if (message.sessionId && this.hidden.has(message.sessionId)) return;
    this.enqueue(() => this.toPlaywright(message));
  }

  private enqueue(task: () => void | Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => this.fatal(error instanceof Error ? error.message : String(error)));
  }

  private toPlaywright(message: CdpMessage): void {
    if (this.closed) return;
    this.pwOnMessage?.(message);
  }

  private async onAttached(message: CdpMessage): Promise<void> {
    const params = message.params as { sessionId: string; targetInfo: { targetId: string; type: string }; waitingForDebugger: boolean };
    const { sessionId, targetInfo, waitingForDebugger } = params;
    const type = targetInfo.type;
    if (!GUARDED_TYPES.has(type) || !waitingForDebugger) {
      // 不受支持的 target（service_worker、shared_worker 等），或已在运行、无法证明守卫先于请求：不交给 Playwright，并关闭
      this.hidden.add(sessionId);
      this.attachLog.push({ type, waiting: waitingForDebugger, outcome: 'hidden' });
      try {
        // 若仍在暂停，先装拒绝一切的守卫（失败无妨，随后关闭 target）
        await this.command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId).catch(() => {});
        await this.command('Target.closeTarget', { targetId: targetInfo.targetId });
      } catch {
        this.fatal(`无法关闭不受支持的 target：${type}`);
      }
      return;
    }
    try {
      await this.command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId).catch((error: unknown) => {
        // dedicated worker 无 Fetch 域：其请求是否经父页面拦截须由真实计数测试证明（待验证，不预设）
        if (type === 'worker' && error instanceof Error && /wasn't found/.test(error.message)) return;
        throw error;
      });
      // 注意：不安装 Network.setBlockedURLs。已用真实 Chromium 158 验证其 urls/urlPatterns 均不能阻止
      // WebSocket 握手（禁止服务仍收到 upgrade），且在 noopener 弹窗上只在恢复后才应答。
      // WebSocket 仅由强制代理按 host:port 准入，不执行本层的方法/路径/正文策略。
      await this.command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch((error: unknown) => {
        // dedicated worker 等可能不支持子级自动附着，但它们的子 worker 也无法绕过父级附着
        if (type === 'page' || type === 'iframe') throw error;
      });
    } catch (error) {
      this.hidden.add(sessionId);
      this.attachLog.push({ type, waiting: true, outcome: 'hidden' });
      this.fatal(`target 守卫安装失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.sessions.set(sessionId, { targetId: targetInfo.targetId, type, guarded: true });
    this.attachLog.push({ type, waiting: true, outcome: 'guarded' });
    this.toPlaywright(message);
  }

  private onPaused(message: CdpMessage): void {
    const params = message.params as { requestId: string; resourceType: string; request: Record<string, unknown> };
    const sessionId = message.sessionId;
    const info = sessionId ? this.sessions.get(sessionId) : undefined;
    const request = params.request;
    const headers: HeaderPairs = Object.entries((request.headers ?? {}) as Record<string, string>).map(([k, v]) => [k, String(v)]);
    const body = decodeBody(request);
    const paused: PausedRequest = {
      url: String(request.url ?? '') + (typeof request.urlFragment === 'string' ? request.urlFragment : ''),
      method: String(request.method ?? 'GET'),
      headers,
      ...(body.body !== undefined ? { body: body.body } : {}),
      bodyUnavailable: body.unavailable,
      resourceType: params.resourceType,
      targetType: info?.type ?? 'unknown',
    };
    let decision: GuardDecision;
    if (!info || !info.guarded) decision = { allow: false, reason: '请求来自未受支持的 target' };
    else {
      try { decision = this.options.decide(paused); }
      catch { decision = { allow: false, reason: '策略检查异常' }; }
    }
    try {
      this.options.onEvent?.({ kind: decision.allow ? 'allowed' : 'blocked', url: paused.url, method: paused.method, resourceType: paused.resourceType, targetType: paused.targetType, ...(decision.allow ? {} : { reason: decision.reason }) });
    } catch { this.fatal('请求安全审计回调失败'); return; }
    const reply = decision.allow
      ? this.command('Fetch.continueRequest', { requestId: params.requestId }, sessionId)
      : this.command('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId);
    // 放行/拒绝命令失败：请求会一直挂起（不会发出），target 已关闭时属正常；其他情况由超时 fail-closed
    reply.catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      if (/超时/.test(text)) this.fatal(text);
    });
  }
}
