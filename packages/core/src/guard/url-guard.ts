import type { Guardrails } from '../schema/guardrails';
import type { GuardResult } from '../verdict/evidence-guard';

function hostAllowed(url: URL, entry: string): boolean {
  const e = entry.toLowerCase();
  const host = url.hostname.toLowerCase();
  const [pattern, port] = e.startsWith('[') ? [e, undefined] : (e.split(':') as [string, string | undefined]);
  if (port !== undefined) {
    const actualPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (actualPort !== port) return false;
  }
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

/** `**` 匹配任意多段，`*` 只匹配单段内的字符 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (ch === '*') {
      re += '[^/]*';
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** 校验 HTTP/浏览器请求是否在白名单内，且不命中禁止规则 */
export function checkRequest(req: { url: string; method?: string }, g: Guardrails): GuardResult {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { ok: false, reason: `无法解析的地址：${req.url}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `不允许的协议：${url.protocol}` };
  }
  if (!g.allowedHosts.some((entry) => hostAllowed(url, entry))) {
    return { ok: false, reason: `主机不在白名单内：${url.host}` };
  }
  const method = (req.method ?? 'GET').toUpperCase();
  for (const rule of g.forbidden) {
    if (rule.method && rule.method.toUpperCase() !== method) continue;
    if (globToRegExp(rule.path).test(url.pathname)) {
      return { ok: false, reason: `命中禁止规则：${rule.method ?? '任意方法'} ${rule.path}` };
    }
  }
  return { ok: true };
}
