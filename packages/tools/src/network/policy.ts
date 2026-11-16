import { checkRequest, type Guardrails, type GuardResult } from '@crosscheck/core';

export type HeaderPairs = [string, string][];
export interface PolicyRequest { url: string; method?: string; headers?: HeaderPairs; body?: string | Uint8Array }

/** 所有 HTTP、浏览器和准备动作必须在发出每个请求之前调用。 */
export class RequestPolicy {
  constructor(private readonly guardrails: Guardrails) {}
  check(request: PolicyRequest): GuardResult {
    let url: URL;
    try { url = new URL(request.url); } catch { return { ok: false, reason: '地址不合法' }; }
    if (url.username || url.password) return { ok: false, reason: '地址禁止包含凭证' };
    const method = (request.method ?? 'GET').toUpperCase();
    if (!/^[A-Z]+$/.test(method)) return { ok: false, reason: '请求方法不合法' };
    const result = checkRequest({ url: request.url, method }, this.guardrails);
    if (!result.ok) return { ok: false, reason: '请求不符合网络策略' };
    if (method === 'HEAD') {
      const get = checkRequest({ url: request.url, method: 'GET' }, this.guardrails);
      if (!get.ok) return { ok: false, reason: '请求不符合网络策略' };
    }
    if ([...url.searchParams.keys()].some(key => key.toLowerCase() === '_method')) return { ok: false, reason: '禁止方法覆盖' };
    const headers = request.headers ?? [];
    if (headers.some(([name]) => ['x-http-method-override', 'x-method-override', 'x-http-method'].includes(name.toLowerCase().trim()))) return { ok: false, reason: '禁止方法覆盖头' };
    if (request.body !== undefined) {
      if (typeof request.body !== 'string') return { ok: false, reason: '无法验证请求正文' };
      const types = headers.filter(([name]) => name.toLowerCase().trim() === 'content-type');
      if (types.length !== 1) return { ok: false, reason: '无法验证正文类型' };
      const type = types[0]![1].split(';')[0]!.trim().toLowerCase();
      if (type === 'application/json') {
        try {
          const value: unknown = JSON.parse(request.body);
          const hasOverride = (v: unknown): boolean => !!v && typeof v === 'object' && Object.entries(v).some(([k, x]) => k.toLowerCase() === '_method' || hasOverride(x));
          if (hasOverride(value)) return { ok: false, reason: '禁止方法覆盖字段' };
        } catch { return { ok: false, reason: '无法验证 JSON 正文' }; }
      } else if (type === 'application/x-www-form-urlencoded') {
        if ([...new URLSearchParams(request.body).keys()].some(k => k.toLowerCase() === '_method')) return { ok: false, reason: '禁止方法覆盖字段' };
      } else return { ok: false, reason: '无法验证正文类型' };
    }
    return { ok: true };
  }
}
