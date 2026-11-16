import type { EvidenceRecord } from '@crosscheck/core';
import type { EvidenceStore } from '../evidence/store';
import type { EvidenceRedactor } from '../evidence/redactor';
import { RequestPolicy, type HeaderPairs, type PolicyRequest } from './policy';

export interface HttpRequest extends PolicyRequest { signal?: AbortSignal }
export type HttpTransport = (url: string, init: RequestInit) => Promise<Response>;
export type HttpIdentity = { headers: (url: string) => Promise<HeaderPairs>; names: string[] };
export interface HttpClientOptions { maxBytes?: number; transport?: HttpTransport; authHeaderNames?: string[] }
export type EvidenceMeta = { actionId: string; phase: EvidenceRecord['phase'] };
export interface HttpResult { summary: { status: number; url: string }; evidenceIds: string[] }
export class HttpOperationError extends Error {
  constructor(message: string, readonly kind: 'blocked' | 'cancelled' | 'limit' | 'network', readonly evidenceIds: string[]) { super(message); this.name = 'HttpOperationError'; }
}

/** 仅可信宿主调用；authHeaders 由宿主按 actor 解析，不得交由模型提供。 */
export class HttpClient {
  private readonly maxBytes: number;
  private readonly transport: HttpTransport;
  private readonly authNames: Set<string>;
  constructor(private readonly policy: RequestPolicy, private readonly evidence: EvidenceStore, private readonly redactor: EvidenceRedactor, options: HttpClientOptions = {}) {
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 1024 * 1024) throw new Error('正文上限不合法');
    this.transport = options.transport ?? fetch;
    this.authNames = new Set(['authorization', 'cookie', 'proxy-authorization', ...(options.authHeaderNames ?? []).map(x => x.toLowerCase())]);
  }
  /** 模型输入拒绝事件不接收原始输入，避免保存凭证或触发网络。 */
  async recordBlocked(meta: EvidenceMeta): Promise<string[]> {
    const har = { log: { version: '1.2', creator: { name: 'crosscheck', version: '1' }, entries: [{ startedDateTime: new Date().toISOString(), time: 0, request: { method: '', url: '', headers: [], cookies: [], queryString: [] }, response: { status: 0, headers: [], cookies: [], content: { mimeType: '', truncated: true } }, failure: { kind: 'blocked', message: '模型输入未通过验证', stage: 'validation', sent: false } }] } };
    return [(await this.evidence.saveHar(har, meta)).id];
  }
  async request(input: HttpRequest, meta: EvidenceMeta, authHeaders: HeaderPairs | HttpIdentity = []): Promise<HttpResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.signal?.aborted) controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    const ids: string[] = [];
    let currentUrl = input.url, currentMethod = (input.method ?? 'GET').toUpperCase();
    let pending = false;
    let persisting = false;
    let failureKind: HttpOperationError['kind'] = 'blocked';
    let resolvingIdentity = false;
    try {
      let url = input.url, method = currentMethod, body = input.body;
      const fixed = Array.isArray(authHeaders) ? authHeaders : [];
      const identity = Array.isArray(authHeaders) ? undefined : authHeaders;
      const identityNames = new Set(identity?.names.map(name => name.toLowerCase()) ?? []);
      const authNames = new Set([...this.authNames, ...fixed.map(([name]) => name.trim().toLowerCase()), ...identityNames]);
      let headers: HeaderPairs = [...(input.headers ?? []), ...fixed].filter(([k]) => k.trim().toLowerCase() !== 'host');
      const seen = new Set<string>();
      for (let hop = 0; hop <= 10; hop++) {
        currentUrl = url; currentMethod = method;
        if (identity) {
          resolvingIdentity = true;
          const resolved = await identity.headers(url);
          resolvingIdentity = false;
          headers = [...headers.filter(([name]) => !identityNames.has(name.toLowerCase())), ...resolved];
        }
        const checked = this.policy.check({ url, method, headers, ...(body !== undefined ? { body } : {}) });
        if (!checked.ok) throw new Error(this.redactor.text(checked.reason ?? '请求被拒绝'));
        const parsed = new URL(url);
        const key = `${method} ${parsed.href}`;
        if (seen.has(key)) throw new Error('检测到重定向循环');
        seen.add(key);
        if (body !== undefined && Buffer.byteLength(body) > this.maxBytes) throw new Error('请求正文超过上限');
        const start = Date.now();
        currentUrl = url; currentMethod = method; pending = true; failureKind = 'network';
        const response = await this.transport(url, { method, headers, ...(typeof body === 'string' ? { body } : {}), redirect: 'manual', signal: controller.signal });
        const chunks: Uint8Array[] = []; let size = 0; let truncated = false;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > this.maxBytes) { truncated = true; controller.abort(); await reader.cancel().catch(() => {}); break; }
              chunks.push(part.value);
            }
          } finally { reader.releaseLock(); }
        }
        const text = Buffer.concat(chunks).toString('utf8');
        const responseHeaders = [...response.headers.entries()] as HeaderPairs;
        const location = response.headers.get('location');
        const pairs = (values: HeaderPairs) => values.map(([name, value]) => ({ name, value }));
        const ct = headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
        const har = { log: { version: '1.2', creator: { name: 'crosscheck', version: '1' }, entries: [{ startedDateTime: new Date(start).toISOString(), time: Date.now()-start, request: { method, url, headers: pairs(headers), cookies: [], queryString: [...parsed.searchParams].map(([name,value]) => ({name,value})), ...(body !== undefined ? { postData: { mimeType: ct, text: typeof body === 'string' ? body : '' } } : {}) }, response: { status: response.status, statusText: response.statusText, headers: pairs(responseHeaders), cookies: [], redirectURL: location ?? '', content: { mimeType: response.headers.get('content-type') ?? '', size, text, truncated } } }] } };
        persisting = true;
        ids.push((await this.evidence.saveHar(har, meta)).id);
        persisting = false; pending = false;
        if (truncated) { failureKind = 'limit'; throw new Error('响应正文超过上限'); }
        failureKind = 'blocked';
        if (![301, 302, 303, 307, 308].includes(response.status) || !location) return { summary: { status: response.status, url: this.redactor.url(url) }, evidenceIds: ids };
        if (hop === 10) throw new Error('重定向次数超限');
        let next: URL;
        try { next = new URL(location, url); } catch { throw new Error('重定向地址不合法'); }
        if (next.origin !== parsed.origin) headers = headers.filter(([name]) => !authNames.has(name.trim().toLowerCase()));
        if (response.status === 303 && method !== 'HEAD' || (response.status === 301 || response.status === 302) && method === 'POST') {
          method = 'GET'; body = undefined;
          headers = headers.filter(([name]) => !['content-type', 'content-length', 'content-encoding', 'transfer-encoding'].includes(name.toLowerCase()));
        }
        url = next.href;
      }
      throw new Error('重定向次数超限');
    } catch (error) {
      if (persisting || resolvingIdentity) throw error;
      const kind = input.signal?.aborted ? 'cancelled' : failureKind;
      if (pending || kind === 'blocked') {
        const har = { log: { version: '1.2', creator: { name: 'crosscheck', version: '1' }, entries: [{ startedDateTime: new Date().toISOString(), time: 0, request: { method: currentMethod, url: currentUrl, headers: [], cookies: [], queryString: [] }, response: { status: 0, headers: [], cookies: [], content: { mimeType: '', truncated: true } }, failure: { kind, message: kind === 'cancelled' ? '请求已取消' : '网络请求失败' } }] } };
        ids.push((await this.evidence.saveHar(har, meta)).id);
      }
      const message = kind === 'cancelled' ? '请求已取消' : kind === 'network' ? '网络请求失败' : this.redactor.text(error instanceof Error ? error.message : '请求失败');
      throw new HttpOperationError(message, kind, ids);
    } finally { input.signal?.removeEventListener('abort', abort); }
  }
}
