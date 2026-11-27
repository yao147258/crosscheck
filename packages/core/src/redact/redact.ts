export const REDACTED = '[REDACTED]';

const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
const DEFAULT_FIELDS = ['password', 'passwd', 'pwd', 'token', 'access_token', 'refresh_token', 'id_token', 'secret', 'client_secret', 'api_key', 'apikey', 'session', 'sid', 'sessionId'];

export interface Redactor {
  headers(h: Record<string, string | string[]>): Record<string, string | string[]>;
  value<T>(v: T): T;
  text(body: string, contentType?: string): string;
  url(u: string): string;
}

// 子串命中的字段名一律脱敏（如 accessToken、X-API-Key、tokenizer_version），
// 宁可误伤也不漏敏感信息
const SENSITIVE_SUBSTRINGS = ['password', 'token', 'secret', 'apikey'];

/** 键名规范化：两端去空白、转小写、去掉 `_` 和 `-`，使驼峰/蛇形/中划线写法等价 */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_-]/g, '');
}

/** 证据落盘前统一脱敏；extraFields 来自 guardrails.yaml 的 redactFields */
export function createRedactor(extraFields: string[] = [], redactValueField?: (key: string, value: unknown) => boolean): Redactor {
  const fields = new Set([...DEFAULT_FIELDS, ...extraFields].map(normalizeKey));
  const isSensitive = (key: string): boolean => {
    const k = normalizeKey(key);
    return fields.has(k) || SENSITIVE_SUBSTRINGS.some((s) => k.includes(s));
  };

  const value = <T>(v: T): T => {
    if (Array.isArray(v)) return v.map((x) => value(x)) as T;
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = isSensitive(k) || redactValueField?.(normalizeKey(k), x) ? REDACTED : value(x);
      return out as T;
    }
    // 处理字符串化的 JSON
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
        try {
          return JSON.stringify(value(JSON.parse(trimmed))) as T;
        } catch {
          return v;
        }
      }
    }
    return v;
  };

  const params = (p: URLSearchParams): URLSearchParams => {
    const out = new URLSearchParams();
    for (const [k, x] of p) out.append(k, isSensitive(k) ? REDACTED : x);
    return out;
  };

  return {
    headers(h) {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(h)) {
        const hit = SENSITIVE_HEADERS.has(k.trim().toLowerCase()) || isSensitive(k);
        out[k] = hit ? (Array.isArray(v) ? v.map(() => REDACTED) : REDACTED) : v;
      }
      return out;
    },
    value,
    text(body, contentType = '') {
      const ct = contentType.toLowerCase();
      if (ct.includes('multipart/')) return '[OMITTED: multipart]';
      if (ct.includes('json')) {
        try {
          return JSON.stringify(value(JSON.parse(body)));
        } catch {
          return body;
        }
      }
      if (ct.includes('application/x-www-form-urlencoded')) return params(new URLSearchParams(body)).toString();
      return body;
    },
    url(u) {
      try {
        const absolute = /^[a-z][a-z\d+.-]*:/i.test(u);
        const protocolRelative = u.startsWith('//');
        const url = new URL(u, 'http://redactor.invalid/');
        // 脱敏 username 和 password
        if (url.username) url.username = REDACTED;
        if (url.password) url.password = REDACTED;
        // 脱敏查询参数
        url.search = params(url.searchParams).toString();
        // 脱敏 hash 中的参数
        if (url.hash && url.hash.includes('=')) {
          const hash = url.hash.slice(1);
          const split = hash.indexOf('?');
          const prefix = split >= 0 ? hash.slice(0, split + 1) : '';
          const hashParams = new URLSearchParams(split >= 0 ? hash.slice(split + 1) : hash);
          url.hash = '#' + prefix + params(hashParams).toString();
        }
        if (absolute) return url.toString();
        if (protocolRelative) return '//' + url.host + url.pathname + url.search + url.hash;
        const path = u.startsWith('/') ? url.pathname : url.pathname.slice(1);
        return path + url.search + url.hash;
      } catch {
        return u;
      }
    },
  };
}
