export const REDACTED = '[REDACTED]';

const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
const DEFAULT_FIELDS = ['password', 'passwd', 'pwd', 'token', 'access_token', 'refresh_token', 'id_token', 'secret', 'client_secret', 'api_key', 'apikey'];

export interface Redactor {
  headers(h: Record<string, string | string[]>): Record<string, string | string[]>;
  value<T>(v: T): T;
  text(body: string, contentType?: string): string;
  url(u: string): string;
}

/** 证据落盘前统一脱敏；extraFields 来自 guardrails.yaml 的 redactFields */
export function createRedactor(extraFields: string[] = []): Redactor {
  const fields = new Set([...DEFAULT_FIELDS, ...extraFields].map((f) => f.toLowerCase()));
  // 字段名包含 password 的也一律脱敏（如 newPassword）
  const isSensitive = (key: string): boolean => {
    const k = key.toLowerCase();
    return fields.has(k) || k.includes('password');
  };

  const value = <T>(v: T): T => {
    if (Array.isArray(v)) return v.map((x) => value(x)) as T;
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = isSensitive(k) ? REDACTED : value(x);
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
        const url = new URL(u);
        // 脱敏 username 和 password
        if (url.username) url.username = REDACTED;
        if (url.password) url.password = REDACTED;
        // 脱敏查询参数
        url.search = params(url.searchParams).toString();
        // 脱敏 hash 中的参数
        if (url.hash && url.hash.includes('=')) {
          const hashParams = new URLSearchParams(url.hash.slice(1)); // 去掉开头的 #
          url.hash = '#' + params(hashParams).toString();
        }
        return url.toString();
      } catch {
        return u;
      }
    },
  };
}
