import { createRedactor, REDACTED, type TraceEvent, type Usage, TraceEventSchema, UsageSchema } from '@crosscheck/core';

export function createEvidenceRedactor(fields: string[] = [], secrets: string[] = []) {
  const base = createRedactor(fields);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length).map(secret => {
    const encoded = encodeURIComponent(secret).replace(/%[0-9A-F]{2}|[^%]/g, part => {
      if (part === '%20') return '(?:%20|\\+)';
      if (part.startsWith('%')) return '%' + [...part.slice(1)].map(c => /[A-F]/.test(c) ? `[${c}${c.toLowerCase()}]` : c).join('');
      return escape(part);
    });
    return new RegExp(`(?:${escape(secret)}|${encoded})`, 'g');
  });
  const text = (s: string): string => patterns.reduce((out, pattern) => out.replace(pattern, () => REDACTED), s);
  const value = <T>(input: T): T => {
    const clean = base.value(input);
    const visit = (v: unknown): unknown => typeof v === 'string' ? text(v) : Array.isArray(v) ? v.map(visit) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), visit(x)])) : v;
    return visit(clean) as T;
  };
  return {
    text, value,
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
