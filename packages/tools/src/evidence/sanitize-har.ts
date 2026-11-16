import type { EvidenceRedactor } from './redactor';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const MAX_BODY = 256 * 1024;

/** 仅接受内存中的 HAR 数据；未知扩展字段不复制。 */
export function sanitizeHar(input: unknown, r: EvidenceRedactor) {
  const log = obj(obj(input).log);
  const pairs = (v: unknown, cookie = false) => arr(v).map(item => {
    const x = obj(item); const name = str(x.name);
    return { name: r.text(name), value: cookie ? '[REDACTED]' : String(r.value({ [name]: str(x.value) })[name] ?? '[REDACTED]') };
  });
  const headers = (v: unknown) => arr(v).map(item => {
    const x = obj(item); const name = str(x.name); const value = str(x.value);
    const cleaned = r.headers({ [name]: value })[name];
    return { name: r.text(name), value: name.toLowerCase().trim() === 'location' ? r.url(String(cleaned)) : String(cleaned) };
  });
  const body = (v: unknown, response: boolean) => {
    const x = obj(v); const mimeType = r.text(str(x.mimeType));
    if (x.truncated === true) return { mimeType, ...(response ? { size: num(x.size) } : {}), text: '[omitted: truncated body]', omitted: true, truncated: true };
    // 已登记的省略正文不可在重新清洗时恢复成完整；不再解析其占位文本。
    if (x.omitted === true) return { mimeType, ...(response ? { size: num(x.size) } : {}), text: '[omitted: source body]', omitted: true, truncated: false };
    if (!response && x.text === undefined && Array.isArray(x.params)) {
      const safeForm = mimeType.toLowerCase().split(';', 1)[0]?.trim() === 'application/x-www-form-urlencoded';
      const valid = x.params.every(item => {
        const p = obj(item);
        return typeof p.name === 'string' && typeof p.value === 'string' && !('fileName' in p) && !('contentType' in p);
      });
      if (safeForm && valid && Buffer.byteLength(JSON.stringify(x.params)) <= MAX_BODY) return { mimeType, params: pairs(x.params), omitted: false, truncated: false };
      return { mimeType, text: '[omitted: unsupported params]', omitted: true, truncated: false };
    }
    if (typeof x.text !== 'string') return { mimeType, ...(response ? { size: num(x.size) } : {}), text: '[omitted: missing body]', omitted: true, truncated: false };
    let text = x.text; let omitted = false; let truncated = false;
    if (x.encoding === 'base64') {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) { text = ''; omitted = true; }
      else {
        const bytes = Buffer.from(text, 'base64');
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = ''; omitted = true; }
      }
    } else if (x.encoding !== undefined && x.encoding !== '') { text = ''; omitted = true; }
    if (Buffer.byteLength(text) > MAX_BODY) { text = ''; omitted = true; truncated = true; }
    if (!omitted) { text = r.body(text, mimeType); omitted = text.startsWith('[omitted:'); }
    return { mimeType, ...(response ? { size: num(x.size) } : {}), text, omitted, truncated };
  };
  return { log: { version: r.text(str(log.version)), creator: r.value(obj(log.creator)), entries: arr(log.entries).map(entry => {
    const e = obj(entry); const req = obj(e.request); const res = obj(e.response);
    const failure = obj(e.failure);
    return { ...(typeof failure.kind === 'string' ? { failure: { kind: r.text(failure.kind), message: r.text(str(failure.message)), ...(typeof failure.stage === 'string' ? { stage: r.text(failure.stage) } : {}), ...(typeof failure.sent === 'boolean' ? { sent: failure.sent } : {}) } } : {}), startedDateTime: r.text(str(e.startedDateTime)), time: num(e.time), request: { method: r.text(str(req.method)), url: r.url(str(req.url)), headers: headers(req.headers), cookies: pairs(req.cookies, true), queryString: pairs(req.queryString), ...(req.postData ? { postData: body(req.postData, false) } : {}) }, response: { status: num(res.status), statusText: r.text(str(res.statusText)), headers: headers(res.headers), cookies: pairs(res.cookies, true), redirectURL: r.url(str(res.redirectURL)), content: body(res.content, true) } };
  }) } };
}
