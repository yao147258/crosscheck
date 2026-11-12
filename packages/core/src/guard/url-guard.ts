import type { Guardrails } from '../schema/guardrails';
import type { GuardResult } from '../verdict/evidence-guard';

function escapeLiteralChar(ch: string): string {
  return ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** 把 glob 片段翻译为正则源码：`**` → `.*`，`*` → `[^/]*`（只匹配单段），其余字符转义为字面量 */
function globFragmentSource(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (ch === '*') {
      re += '[^/]*';
    } else {
      re += escapeLiteralChar(ch);
    }
  }
  return re;
}

/** 解析白名单条目的主机名与端口；支持 `host`、`host:port`、`[ipv6]`、`[ipv6]:port`。
 * 端口是否“写明”看条目原文是否以 `:数字` 结尾，不依赖 URL 对默认端口（80/443）的省略行为。 */
function parseHostEntry(entry: string): { hostname: string; port: string | null } | null {
  try {
    const parsed = new URL(`http://${entry}`);
    const portMatch = /:(\d+)$/.exec(entry);
    return { hostname: parsed.hostname.toLowerCase(), port: portMatch ? portMatch[1]! : null };
  } catch {
    return null;
  }
}

function hostAllowed(url: URL, entry: string): boolean {
  const trimmed = entry.trim();
  if (trimmed.toLowerCase().startsWith('*.')) {
    const suffix = trimmed.slice(1).toLowerCase();
    return url.hostname.toLowerCase().endsWith(suffix);
  }
  const parsed = parseHostEntry(trimmed);
  if (!parsed) return false;
  if (url.hostname.toLowerCase() !== parsed.hostname) return false;
  if (parsed.port !== null) {
    const actualPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (actualPort !== parsed.port) return false;
  }
  return true;
}

/**
 * `**` 匹配任意多段（其前缀自身也算匹配，即 `/api/**` 也匹配 `/api`），`*` 只匹配单段内的字符；忽略大小写。
 * 规则路径自身也规范化末尾的 `/`（`/api/` 等价于 `/api`），与请求路径的规范化保持一致。
 */
function globToRegExp(glob: string): RegExp {
  const normalizedGlob = glob.length > 1 && glob.endsWith('/') ? glob.slice(0, -1) : glob;
  const re = globFragmentSource(normalizedGlob);
  if (normalizedGlob.endsWith('/**')) {
    const prefix = globFragmentSource(normalizedGlob.slice(0, -3));
    return new RegExp(`^(?:${prefix}|${re})$`, 'i');
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * 规范化 pathname 仅用于禁止规则匹配（不修改实际请求）：
 * - 含编码的 `/` 或 `\`（`%2f`、`%5c`，不区分大小写）或原始 `\` → 视为非法，返回 null
 * - 按段 decodeURIComponent（解码失败 → null）
 * - 去掉每段中 `;` 及其后内容（矩阵参数）
 * - 任何一段（去掉矩阵参数后）为 `.` 或 `..` → 视为非法，返回 null（防止 `/foo/..;/admin` 这类伪装）
 * - 合并连续的 `/`，去掉末尾的 `/`（根路径 `/` 保留）
 * - 转为小写，便于大小写无关匹配
 */
function normalizePathForMatch(pathname: string): string | null {
  if (/%2f|%5c/i.test(pathname) || pathname.includes('\\')) return null;
  const segments = pathname.split('/');
  const decoded: string[] = [];
  for (const seg of segments) {
    let d: string;
    try {
      d = decodeURIComponent(seg);
    } catch {
      return null;
    }
    const semi = d.indexOf(';');
    const trimmed = semi === -1 ? d : d.slice(0, semi);
    if (trimmed === '.' || trimmed === '..') return null;
    decoded.push(trimmed);
  }
  let merged = decoded.join('/').replace(/\/+/g, '/');
  if (merged.length > 1 && merged.endsWith('/')) merged = merged.slice(0, -1);
  return merged.toLowerCase();
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
  const normalizedPath = normalizePathForMatch(url.pathname);
  if (normalizedPath === null) {
    return { ok: false, reason: `路径包含不允许的编码：${url.pathname}` };
  }
  const method = (req.method ?? 'GET').trim().toUpperCase();
  for (const rule of g.forbidden) {
    if (rule.method && rule.method.trim().toUpperCase() !== method) continue;
    if (globToRegExp(rule.path).test(normalizedPath)) {
      return { ok: false, reason: `命中禁止规则：${rule.method ?? '任意方法'} ${rule.path}` };
    }
  }
  return { ok: true };
}
