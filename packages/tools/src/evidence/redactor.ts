import { createRedactor, REDACTED, type TraceEvent, type Usage, TraceEventSchema, UsageSchema } from '@crosscheck/core';

export function createEvidenceRedactor(fields: string[] = [], secrets: string[] = []) {
  const base = createRedactor(fields);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const known = new Set<string>();
  let patterns: RegExp[] = [];
  const addSecrets = (values: string[]) => {
    for (const value of values) if (value) {
      known.add(value);
      const bytes = Buffer.from(value);
      known.add(bytes.toString('base64'));
      known.add(bytes.toString('base64url'));
    }
    patterns = [...known].sort((a, b) => b.length - a.length).map(secret => {
      const encoded = encodeURIComponent(secret).replace(/%[0-9A-F]{2}|[^%]/g, part => {
        if (part === '%20') return '(?:%20|\\+)';
        if (part.startsWith('%')) return '%' + [...part.slice(1)].map(c => /[A-F]/.test(c) ? `[${c}${c.toLowerCase()}]` : c).join('');
        return escape(part);
      });
      return new RegExp(`(?:${escape(secret)}|${encoded})`, 'g');
    });
  };
  addSecrets(secrets);
  const text = (s: string): string => patterns.reduce((out, pattern) => out.replace(pattern, () => REDACTED), s);
  const value = <T>(input: T): T => {
    const clean = base.value(input);
    const visit = (v: unknown): unknown => typeof v === 'string' ? text(v) : Array.isArray(v) ? v.map(visit) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), visit(x)])) : v;
    return visit(clean) as T;
  };
  /** 展示自由文本先按JSON/明确URL语义清洗，再替换已知秘密；不处理可信用量数字。 */
  const displayText = (input: string): string => {
    const urls = (s: string) => s.replace(/https?:\/\/\S+/gi, (match: string, offset: number) => {
      // 以空白界定完整token；查询中的引号/尖括号不能提前截断，留下敏感值后缀。
      const opening = s[offset - 1];
      const closing = opening === '<' ? '>' : opening && ['"', "'", '`'].includes(opening) ? opening : undefined;
      const suffix = closing && match.endsWith(closing) ? closing : '';
      const candidate = suffix ? match.slice(0, -suffix.length) : match;
      try { new URL(candidate); return base.url(candidate) + suffix; }
      catch { return '[omitted: ambiguous url]' + suffix; }
    });
    const project = (v: unknown, key = ''): unknown => {
      if (typeof v === 'string') {
        const trimmed = v.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try { return JSON.stringify(value(project(JSON.parse(trimmed)))); } catch { /* 非JSON仍按普通文本处理。 */ }
        }
        if (/(?:url|uri)$/i.test(key)) return base.url(v);
        // runner原因会在JSON前附加阶段说明；逐个平衡片段解析，不能只处理整串JSON。
        let out = '', cursor = 0;
        const urlRanges = [...v.matchAll(/https?:\/\/\S+/gi)].map(match => ({ start: match.index, end: match.index + match[0].length }));
        for (let start = 0; start < v.length; start++) {
          if (v[start] !== '{' && v[start] !== '[') continue;
          // URL token中的JSON形状字符仍属于URL，不能先拆出片段导致敏感值范围缩短。
          const urlRange = urlRanges.find(range => start >= range.start && start < range.end);
          if (urlRange) { start = urlRange.end - 1; continue; }
          let depth = 0, quoted = false, escaped = false;
          for (let end = start; end < v.length; end++) {
            const char = v[end];
            if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
            else if (char === '"') quoted = true;
            else if (char === '{' || char === '[') depth++;
            else if (char === '}' || char === ']') depth--;
            if (depth === 0) {
              try {
                const parsed = JSON.parse(v.slice(start, end + 1));
                out += urls(v.slice(cursor, start)) + JSON.stringify(value(project(parsed)));
                cursor = end + 1; start = end;
              } catch { /* 非JSON片段保留为普通文本。 */ }
              break;
            }
          }
        }
        return out + urls(v.slice(cursor));
      }
      if (Array.isArray(v)) return v.map(child => project(child));
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, project(child, k)]));
      return v;
    };
    return text(String(value(project(input))));
  };
  return {
    text, displayText, value, addSecrets,
    usage: (usage: Usage): Usage => UsageSchema.parse(usage),
    url: (s: string) => {
      try { new URL(s, 'http://redactor.invalid/'); } catch { return '[omitted: invalid url]'; }
      return text(base.url(s));
    },
    headers: (h: Record<string, string | string[]>) => value(base.headers(h)),
    body: (body: string, contentType: string): string => {
      const ct = contentType.toLowerCase();
      if (ct.includes('multipart/')) return '[omitted: multipart]';
      if (ct.includes('json')) {
        try { return JSON.stringify(value(JSON.parse(body))); } catch { return '[omitted: invalid json]'; }
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
