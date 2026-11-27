import { domainToASCII, domainToUnicode } from 'node:url';
import { createRedactor, REDACTED, type TraceEvent, type Usage, TraceEventSchema, UsageSchema } from '@crosscheck/core';

const credentialFields = ['authorization', 'proxyauthorization', 'cookie', 'setcookie'];
const sensitiveHost = '[omitted: sensitive url host]';
const maxJsonDepth = 64;
const normalizeKey = (key: string) => key.trim().toLowerCase().replace(/[_-]/g, '');
const isSpace = (char: string) => /\s/u.test(char);

/** 先索引不透明片段，再配对展示用标签；任何位置都不必重新搜索整段尾部。 */
function markdownLayout(text: string, json: Uint32Array | undefined) {
  const ends = new Uint32Array(text.length);
  const parents = new Uint32Array(text.length);
  const destinations = new Uint8Array(text.length);
  const codeEnds = new Map<number, { close: number; end: number }>();
  const codeRuns = [...text.matchAll(/`+/g)];
  const nextRun = new Map<number, { close: number; end: number }>();
  for (let i = codeRuns.length - 1; i >= 0; i--) {
    const { 0: ticks, index } = codeRuns[i]!;
    const width = ticks.length;
    const next = nextRun.get(width);
    if (next) codeEnds.set(index, next);
    nextRun.set(width, { close: index, end: index + width });
  }

  const openings: number[] = [];
  const code = new Map<number, { close: number; end: number }>();
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const span = codeEnds.get(i);
    if (span) { code.set(i, span); i = span.end - 1; continue; }
    if (char === '\\' && /[\\[\]`]/.test(text[i + 1] ?? '')) { i++; continue; }
    const fragment = (char === '{' || char === '[') ? json?.[i] : 0;
    if (fragment) {
      // JSON 数组也可能恰好是标签，只有其外层方括号可以参与配对。
      if (char === '[') ends[i] = fragment;
      i = fragment - 1;
    } else if (char === '[') openings.push(i);
    else if (char === ']' && openings.length) ends[openings.pop()!] = i + 1;
  }

  const inline = /\(<?(?=https?:\/\/)/iy;
  const auto = /<https?:\/\//iy;
  const enclosing: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (enclosing.at(-1) === i) enclosing.pop();
    const end = ends[i];
    if (!end) continue;
    inline.lastIndex = end;
    if (!inline.test(text)) continue;
    destinations[inline.lastIndex] = 1;
    parents[inline.lastIndex] = enclosing.at(-1) ?? 0;
    enclosing.push(end);
  }
  return {
    code, destinations, parents,
    startsLink(index: number) {
      auto.lastIndex = index;
      if (text[index] === '<') return auto.test(text);
      const label = text[index] === '!' ? index + 1 : index;
      const end = ends[label];
      if (!end) return false;
      inline.lastIndex = end;
      return inline.test(text);
    },
  };
}

/** 只解码历史中出现过的普通转义形式；不使用展示分词，也不解释转义文本为 Markdown。 */
function unescapeJsonText(text: string): string {
  return text.replace(/\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/g, token => JSON.parse(`"${token}"`) as string);
}

function unescapePercent(text: string): string {
  return text.replace(/(?:%[\da-fA-F]{2})+/g, token => Buffer.from(token.replace(/%/g, ''), 'hex').toString('utf8'));
}

/** 从右到左缓存各后缀的结束位置（0 表示无效），避免每个未闭合括号重扫尾部。 */
function jsonValueEnds(text: string) {
  const n = text.length;
  const next = new Uint32Array(n + 1);
  const stringTail = new Uint32Array(n + 1);
  const values = new Uint32Array(n + 1);
  const members = new Uint32Array(n + 1);
  const elements = new Uint32Array(n + 1);
  const literal = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  const escape = /\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/y;
  const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  next[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = text[i]!;
    const after = next[i + 1]!;
    next[i] = /[ \t\r\n]/.test(c) ? after : i;
    if (c === '"') {
      stringTail[i] = i + 1;
      values[i] = stringTail[i + 1]!;
    } else if (c === '\\') {
      escape.lastIndex = i;
      if (escape.exec(text)) stringTail[i] = stringTail[escape.lastIndex]!;
    } else if (c >= ' ') stringTail[i] = stringTail[i + 1]!;
    if (c === '{') values[i] = text[after] === '}' ? after + 1 : members[after]!;
    else if (c === '[') values[i] = text[after] === ']' ? after + 1 : elements[after]!;
    else if (c === 't' || c === 'f' || c === 'n' || c === '-' || (isDigit(c) && !isDigit(text[i - 1]))) {
      // 数字中部不可能是独立值，避免长数字被重复扫描。
      literal.lastIndex = i;
      if (literal.exec(text)) values[i] = literal.lastIndex;
    }
    const end = values[i]!;
    if (!end) continue;
    const separator = next[end]!;
    if (text[separator] === ']') elements[i] = separator + 1;
    else if (text[separator] === ',') elements[i] = elements[next[separator + 1]!]!;
    if (c !== '"' || text[separator] !== ':') continue;
    const memberEnd = values[next[separator + 1]!]!;
    if (!memberEnd) continue;
    const memberSeparator = next[memberEnd]!;
    if (text[memberSeparator] === '}') members[i] = memberSeparator + 1;
    else if (text[memberSeparator] === ',') members[i] = members[next[memberSeparator + 1]!]!;
  }
  return { values, next };
}

/** 脱敏可能把不同键映射为同一占位符；优先保留未改动键，再给冲突项分配稳定后缀。 */
function distinctRedactedNames(names: string[], redact: (name: string) => string): string[] {
  const projected = names.map(redact);
  const reserved = new Set(projected.filter((name, i) => name === names[i]));
  const assigned = new Set<string>();
  const nextSuffix = new Map<string, number>();
  return projected.map((base, i) => {
    let name = base;
    if (assigned.has(name) || (name !== names[i] && reserved.has(name))) {
      let suffix = nextSuffix.get(base) ?? 2;
      do { name = `${base} #${suffix++}`; } while (reserved.has(name) || assigned.has(name));
      nextSuffix.set(base, suffix);
    }
    assigned.add(name);
    return name;
  });
}

/** 已验证的 JSON 逐 token 投影，只解码字符串；数字不进入 JS Number。 */
function projectJson(
  source: string, index: ReturnType<typeof jsonValueEnds>, start: number, depth: number,
  displayString: (value: string, key: string, depth: number) => string,
  redactKey: (key: string, inHeaders: boolean, headerValue: boolean) => boolean,
  redactText: (value: string) => string, redactName: (name: string) => string,
): string {
  const { next, values } = index;
  const parts: string[] = [];
  const decode = (at: number): string => JSON.parse(source.slice(at, values[at]!));
  const stringArray = (at: number): boolean => {
    for (let item = next[at + 1]!; source[item] !== ']'; item = next[next[values[item]!]! + 1]!) {
      if (source[item] !== '"') return false;
      if (source[next[values[item]!]!] === ']') break;
    }
    return true;
  };
  const emit = (at: number, level: number, key = '', inHeaders = false) => {
    if (level >= maxJsonDepth) { parts.push('"[omitted: nested json]"'); return; }
    const char = source[at];
    if (char === '"') {
      parts.push(JSON.stringify(displayString(decode(at), key, level + 1)));
    } else if (char === '{') {
      // 同一个原始键重复时延续 JSON.parse 的末值语义，不把它当作两个脱敏键。
      const members = new Map<string, number>();
      for (let item = next[at + 1]!; source[item] !== '}';) {
        const child = next[next[values[item]!]! + 1]!;
        members.set(decode(item), child);
        const separator = next[values[child]!]!;
        if (source[separator] !== ',') break;
        item = next[separator + 1]!;
      }
      const entries = [...members];
      const projected = distinctRedactedNames(entries.map(([name]) => name), redactName);
      parts.push('{');
      for (const [i, [name, item]] of entries.entries()) {
        if (i) parts.push(',');
        parts.push(JSON.stringify(projected[i]), ':');
        if (redactKey(name, inHeaders, source[item] === '"' || (source[item] === '[' && credentialFields.includes(normalizeKey(name)) && stringArray(item)))) {
          parts.push(JSON.stringify(REDACTED));
        } else emit(item, level + 1, name, normalizeKey(name) === 'headers');
      }
      parts.push('}');
    } else if (char === '[') {
      parts.push('[');
      for (let item = next[at + 1]!; source[item] !== ']';) {
        emit(item, level + 1);
        const separator = next[values[item]!]!;
        if (source[separator] !== ',') break;
        parts.push(',');
        item = next[separator + 1]!;
      }
      parts.push(']');
    } else {
      const token = source.slice(at, values[at]!);
      parts.push(redactText(token) === token ? token : JSON.stringify(REDACTED));
    }
  };
  emit(start, depth);
  return parts.join('');
}

export function createEvidenceRedactor(fields: string[] = [], secrets: string[] = []) {
  // URL、表单及明确的 headers 有凭据语义；通用对象仍允许名为 cookie 的角色。
  const base = createRedactor([...fields, ...credentialFields]);
  const structured = createRedactor(fields);
  const fieldCache = new Map<string, boolean>();
  const redactKey = (key: string, inHeaders: boolean, headerValue: boolean) => {
    const normalized = normalizeKey(key);
    if ((inHeaders || headerValue) && credentialFields.includes(normalized)) return true;
    const cached = fieldCache.get(normalized);
    if (cached !== undefined) return cached;
    // 用标量探测核心规则，避免核心递归重新解析已经无损处理过的 JSON 字符串。
    const result = structured.value<Record<string, unknown>>({ [normalized]: false })[normalized] === REDACTED;
    if (fieldCache.size < 256) fieldCache.set(normalized, result);
    return result;
  };
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const known = new Set<string>();
  let patterns: RegExp[] = [];
  let hostSecrets: string[] = [];
  const addSecrets = (values: string[]) => {
    for (const value of values) if (value) {
      known.add(value);
      const bytes = Buffer.from(value);
      known.add(bytes.toString('base64'));
      known.add(bytes.toString('base64url'));
    }
    hostSecrets = [...known].flatMap(secret => {
      // 交给 IDNA 判断 Unicode 字符是否合法；先排除 ASCII 分隔符、百分号和空白，防止转换时只取密钥的一部分。
      const literal = secret.toLowerCase();
      if (!/^(?:[\w.-]|[^\x00-\x7f])+$/u.test(secret) || /\s/u.test(secret)) return [literal];
      // 加后缀避免把数字密钥解释为 IPv4；验证后缀完整保留，拒绝被截断的转换。
      const suffix = '.invalid';
      const host = domainToASCII(secret + suffix);
      if (!host.endsWith(suffix)) return [literal];
      const ascii = host.slice(0, -suffix.length);
      const decoded = domainToUnicode(host);
      const unicode = decoded.endsWith(suffix) ? decoded.slice(0, -suffix.length) : '';
      // 忽略字符折叠后不能只剩域名标点。
      return /[\p{L}\p{M}\p{N}]|[^\x00-\x7f]/u.test(unicode) ? [literal, ascii, unicode] : [literal];
    });
    patterns = [...known].sort((a, b) => b.length - a.length).map(secret => {
      // URL 可逐字符混用原文与一层百分号编码，包括字母；只匹配已登记的秘密。
      const encoded = Array.from(secret, char => {
        const percent = Buffer.from(char).toString('hex').toUpperCase().replace(/../g,
          byte => '%' + byte.replace(/[A-F]/g, c => `[${c}${c.toLowerCase()}]`));
        return `(?:${escape(char)}|${percent}${char === ' ' ? '|\\+' : ''})`;
      }).join('');
      return new RegExp(encoded, 'g');
    });
  };
  addSecrets(secrets);
  const text = (s: string): string => patterns.reduce((out, pattern) => out.replace(pattern, () => REDACTED), s);
  const matchesKnownText = (s: string) => patterns.some(pattern => {
    const hit = pattern.test(s);
    pattern.lastIndex = 0;
    return hit;
  });
  const matchesHost = (host: string) => {
    const ascii = host.toLowerCase();
    if (!ascii) return false;
    // Punycode 编码整枚标签，密钥的独立编码不一定是其中的子串。
    const unicode = domainToUnicode(ascii).toLowerCase();
    return hostSecrets.some(secret => ascii.includes(secret) || unicode.includes(secret));
  };
  const scanHosts = (s: string) => {
    if (!hostSecrets.length) return false;
    // 找出每个协议起点，不让前一个 URL 的路径、查询或锚点吞掉后面的主机。
    const authority = /[^\s/\\?#<>()[\]{}"`]+/uy;
    for (const { index } of s.matchAll(/\/\//g)) {
      authority.lastIndex = index + 2;
      const part = authority.exec(s)?.[0];
      if (!part) continue;
      try { if (matchesHost(new URL(`http://${part}`).hostname)) return true; } catch { /* 不是可转换的主机。 */ }
    }
    // 旧版还可能只留下 Punycode 主机（如先前 URL 的编码参数或片段）。
    for (const { 0: host } of s.matchAll(/[a-z\d_.-]+/gi)) {
      if (/(?:^|\.)xn--/i.test(host) && matchesHost(host)) return true;
    }
    return false;
  };
  const scanRepresentations = (input: string, scan: (s: string) => boolean): boolean => {
    // 固定轮数覆盖历史中的 JSON 字符串和 URL 重新编码；不递归遍历 Markdown，
    // 对象键和格式残缺的记录与普通正文在同一条安全路径上。
    let decoded = input;
    for (let layer = 0; layer <= 2; layer++) {
      if (scan(decoded)) return true;
      let percent = decoded;
      for (let round = 0; round < 2 && percent.includes('%'); round++) {
        const unescaped = unescapePercent(percent);
        if (unescaped === percent) break;
        percent = unescaped;
        if (scan(percent) || (percent.includes('\\') && scan(unescapeJsonText(percent)))) return true;
      }
      if (layer === 2 || !decoded.includes('\\')) break;
      const unescaped = unescapeJsonText(decoded);
      if (unescaped === decoded) break;
      decoded = unescaped;
    }
    return false;
  };
  const containsKnownSecret = (input: string) => patterns.length > 0 && scanRepresentations(input, s => matchesKnownText(s) || scanHosts(s));
  const containsSensitiveHost = (s: string) => hostSecrets.length > 0 && scanRepresentations(s, scanHosts);
  const cleanKey = (s: string) => containsSensitiveHost(s) ? sensitiveHost : text(s);
  const cleanUrl = (s: string, invalid = '[omitted: invalid url]'): string => {
    let url: URL;
    try { url = new URL(s, 'http://redactor.invalid/'); } catch { return invalid; }
    if ((/^\s*(?:[a-z][a-z\d+.-]*:|[/\\]{2})/i.test(s) && matchesHost(url.hostname)) || containsSensitiveHost(s)) return sensitiveHost;
    return text(base.url(s));
  };

  const hasEmbeddedCredentials = (candidate: string, afterScheme: number): boolean => {
    const schemes = /https?:\/\//gi;
    schemes.lastIndex = afterScheme;
    let inner = schemes.exec(candidate);
    while (inner) {
      const next = schemes.exec(candidate);
      try {
        const url = new URL(candidate.slice(inner.index, next?.index));
        // 与核心 URL 规则比较的是参数键，不把普通的 URL 规范化当作凭据命中。
        const fragment = url.hash.slice(1);
        const params = new URLSearchParams(fragment.slice(fragment.indexOf('?') + 1));
        if (url.username || url.password || [...url.searchParams.keys(), ...params.keys()].some(key => redactKey(key, true, true))) return true;
      } catch { /* 外层仍执行普通 URL 清洗。 */ }
      inner = next;
    }
    return false;
  };

  type JsonIndex = ReturnType<typeof jsonValueEnds>;
  const encodeJson = (s: string, index: JsonIndex, at: number, depth: number, display: boolean) =>
    projectJson(s, index, at, depth, display ? displayText : (v, _key, level) => structuredString(v, level), redactKey, text, cleanKey);
  const wholeJson = (s: string, depth: number, compositeOnly: boolean): string | undefined => {
    const input = compositeOnly ? s.trim() : s;
    if (compositeOnly && !/^[{\[]/.test(input)) return undefined;
    const index = jsonValueEnds(input);
    const at = index.next[0]!;
    const end = index.values[at]!;
    if (end && index.next[end] === input.length) return encodeJson(input, index, at, depth, false);
    return undefined;
  };
  const structuredString = (s: string, depth: number) =>
    depth >= maxJsonDepth ? '[omitted: nested json]' : wholeJson(s, depth, true) ?? text(s);
  const value = <T>(input: T): T => {
    const visit = (v: unknown, inHeaders = false): unknown => {
      if (typeof v === 'string') return structuredString(v, 0);
      if (Array.isArray(v)) return v.map(item => visit(item));
      if (v && typeof v === 'object') {
        const entries = Object.entries(v);
        const projected = distinctRedactedNames(entries.map(([key]) => key), cleanKey);
        return Object.fromEntries(entries.map(([key, child], i) => [projected[i]!,
          redactKey(key, inHeaders, typeof child === 'string' || (credentialFields.includes(normalizeKey(key)) && Array.isArray(child) && child.every(item => typeof item === 'string')))
            ? REDACTED : visit(child, normalizeKey(key) === 'headers'),
        ]));
      }
      return v;
    };
    return visit(input) as T;
  };

  /** 展示布局仅确定转义与边界，不作为历史密钥检查的依据。 */
  function displayText(s: string, key = '', level = 0): string {
    if (level >= maxJsonDepth) return '[omitted: nested json]';
    const json = /[{\[]/.test(s) ? jsonValueEnds(s) : undefined;
    const first = json?.next[0] ?? 0;
    const whole = json?.values[first];
    if (json && whole && (s[first] === '{' || s[first] === '[') && json.next[whole] === s.length) return encodeJson(s, json, first, level, true);
    if (/(?:url|uri)$/i.test(key)) return cleanUrl(s);

    const scheme = /https?:\/\//iy;
    const layout = /https?:\/\//i.test(s) && /[<\[`]/.test(s) ? markdownLayout(s, json?.values) : undefined;
    let cursor = 0;
    let codeClose = -1;
    let codeEnd = -1;
    const parts: string[] = [];
    for (let start = 0; start < s.length;) {
      const char = s[start];
      const span = layout?.code.get(start);
      if (span) { codeClose = span.close; codeEnd = span.end; }
      const endJson = (char === '{' || char === '[') ? json?.values[start] : 0;
      if (json && endJson && (start >= codeEnd || endJson <= codeClose)) {
        parts.push(text(s.slice(cursor, start)), encodeJson(s, json, start, level, true));
        cursor = start = endJson;
        continue;
      }
      scheme.lastIndex = start;
      if ((char !== 'h' && char !== 'H') || !scheme.test(s)) { start++; continue; }
      const inCode = start < codeClose;
      const inline = !inCode && layout?.destinations[start] === 1;
      const angled = s[start - 1] === '<';
      const parent = inline ? layout?.parents[start] : 0;
      // 贴着普通正文的反引号也可能是查询值的一部分；仅在明确边界处收窄 URL。
      const codeBoundary = inCode && (codeEnd === s.length || isSpace(s[codeEnd]!) || s[codeEnd] === ']' || layout?.startsLink(codeEnd));
      const limit = codeBoundary ? codeClose : parent ? parent - 1 : s.length;
      let end = scheme.lastIndex;
      let depth = 0;
      for (; end < limit && !isSpace(s[end]!); end++) {
        const ch = s[end];
        const fragment = (ch === '{' || ch === '[') ? json?.values[end] : 0;
        // 只在 URL 边界分析中跳过片段；清洗时仍把原片段当作 URL 的一部分。
        if (fragment && fragment <= limit) { end = fragment - 1; continue; }
        if (inline && !angled && ch === '(') { depth++; continue; }
        if (inline && !angled && ch === ')' && depth) { depth--; continue; }
        if ((angled && ch === '>') || (inline && ch === ')' && !angled)) {
          const after = end + (angled && inline && s[end + 1] === ')' ? 2 : 1);
          if (parent || layout?.startsLink(after) || (angled && (after === limit || isSpace(s[after]!)))) break;
        }
      }
      const opening = s[start - 1];
      const closing = angled ? (inline && s.slice(end - 2, end) === '>)' ? '>)' : '>')
        : inline ? ')' : opening === '"' || opening === "'" || opening === '`' ? opening : '';
      const token = s.slice(start, end);
      const suffix = closing && token.endsWith(closing) ? closing : '';
      const candidate = suffix ? token.slice(0, -suffix.length) : token;
      // 不可靠的边界不能把后一个 URL 塞回前一个锚点或查询后原样输出。
      // 仅当被吞并的 URL 确实需要清理时，才省略整个歧义 token。
      const cleaned = cleanUrl(candidate, '[omitted: ambiguous url]');
      parts.push(text(s.slice(cursor, start)), cleaned !== sensitiveHost && hasEmbeddedCredentials(candidate, scheme.lastIndex - start)
        ? '[omitted: ambiguous url]' : cleaned, suffix);
      cursor = start = end;
    }
    parts.push(text(s.slice(cursor)));
    return parts.join('');
  }
  return {
    text, displayText: (input: string) => displayText(input), value, addSecrets, containsKnownSecret,
    usage: (usage: Usage): Usage => UsageSchema.parse(usage),
    url: (s: string) => cleanUrl(s),
    headers: (h: Record<string, string | string[]>) => value(base.headers(h)),
    body: (body: string, contentType: string): string => {
      const ct = contentType.toLowerCase();
      if (ct.includes('multipart/')) return '[omitted: multipart]';
      if (ct.includes('json')) {
        return wholeJson(body, 0, false) ?? '[omitted: invalid json]';
      }
      if (ct.includes('application/x-www-form-urlencoded')) return text(base.text(body, contentType));
      if (ct.startsWith('text/')) return text(body);
      return '[omitted: unsupported body]';
    },
    trace(event: TraceEvent): TraceEvent {
      const cleaned = value(event);
      return TraceEventSchema.parse(cleaned);
    },
  };
}
export type EvidenceRedactor = ReturnType<typeof createEvidenceRedactor>;
