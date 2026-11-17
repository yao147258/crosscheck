import type { BrowserContext, ConsoleMessage, Request, Response } from 'playwright';
import type { EvidenceRedactor } from '../evidence/redactor';
import { sanitizeHar } from '../evidence/sanitize-har';
import type { EvidenceStore } from '../evidence/store';
import type { EvidenceMeta } from '../network/http-client';

type Entry = { request: unknown; response: unknown; failure?: { kind: string; message: string } };
const LIMIT = 200, TEXT_LIMIT = 8192;
/** 只监听内存事件，不配置原始 HAR/trace 文件；正文默认省略，避免读取无限/压缩响应。 */
export class BrowserEvents {
  private entries: Entry[] = [];
  private logs: string[] = [];
  private active = new WeakMap<Request, Entry>();
  private count = 0;
  private consoleCount = 0;
  private dropped = 0;
  private consoleDropped = 0;
  private closed = false;
  constructor(private readonly context: BrowserContext, private readonly redactor: EvidenceRedactor) {
    context.on('request', this.request);
    context.on('response', this.response);
    context.on('requestfailed', this.failed);
    context.on('console', this.console);
  }
  private requestData(req: Request) {
    const url = req.url();
    for (const [name, value] of Object.entries(req.headers())) {
      if (/^(?:authorization|proxy-authorization|x-api-key|x-auth-token)$/i.test(name)) {
        this.redactor.addSecrets([value]);
        const component = /^\S+\s+(.+)$/.exec(value)?.[1];
        if (component) this.redactor.addSecrets([component]);
      }
      if (name.toLowerCase() === 'cookie') this.redactor.addSecrets(value.split(';').map(pair => pair.slice(pair.indexOf('=') + 1).trim()).filter(Boolean));
    }
    return { method: req.method(), url: url.length <= TEXT_LIMIT ? this.redactor.url(url) : 'about:blank#omitted-url-limit',
      headers: [], cookies: [], queryString: [], ...(!['GET', 'HEAD'].includes(req.method()) ? { postData: { mimeType: req.headers()['content-type'] ?? '', omitted: true } } : {}) };
  }
  private entry(req: Request): Entry | undefined {
    const previous = this.active.get(req);
    if (previous && this.entries.includes(previous)) return previous;
    if (this.count++ >= LIMIT) { this.dropped++; return; }
    const entry: Entry = { request: this.requestData(req), response: { status: 0, content: { omitted: true } }, failure: { kind: 'pending', message: '响应尚未观察；请求正文和头已省略' } };
    this.active.set(req, entry); this.entries.push(entry); return entry;
  }
  private request = (req: Request) => { this.entry(req); };
  private response = (res: Response) => {
    const entry = this.entry(res.request()); if (!entry) return;
    entry.response = { status: res.status(), headers: [], cookies: [], content: { mimeType: (res.headers()['content-type'] ?? '').slice(0, 256), omitted: true } };
    entry.failure = { kind: 'omitted', message: '响应正文、头和 Cookie 在源采集阶段省略；不代表完整响应' };
  };
  private failed = (req: Request) => {
    const entry = this.entry(req); if (entry) entry.failure = { kind: 'requestfailed', message: this.redactor.text(req.failure()?.errorText ?? '请求失败').slice(0, TEXT_LIMIT) };
  };
  private console = (msg: ConsoleMessage) => {
    if (this.consoleCount++ >= LIMIT) { this.consoleDropped++; return; }
    const text = msg.text();
    this.logs.push(text.length > TEXT_LIMIT ? '[omitted: console text limit]' : this.redactor.displayText(`${msg.type()}: ${text}`));
  };
  /** 事件处理器不启动异步写入；flush 的所有写盘由调用者顺序 await。 */
  async flush(store: EvidenceStore, meta: EvidenceMeta): Promise<string[]> {
    if (this.dropped) this.entries.push({ request: { method: 'OMITTED', url: 'about:blank' }, response: { status: 0, content: { omitted: true, truncated: true } }, failure: { kind: 'limit', message: `事件限额，省略 ${this.dropped} 个网络事件` } });
    const har = sanitizeHar({ log: { version: '1.2', creator: { name: 'crosscheck', version: '1' }, entries: this.entries } }, this.redactor);
    const consoleText = this.redactor.displayText(this.logs.join('\n') + (this.consoleDropped ? `\n[omitted: ${this.consoleDropped} console events]` : '') + '\n[omitted: console 对象参数与页面异常堆栈未采集]');
    // 先交换缓冲区，写盘期间到达的事件留给下一次 flush；失败必须向宿主传播。
    this.entries = []; this.logs = []; this.dropped = 0; this.consoleDropped = 0;
    const network = await store.saveHar(har, meta);
    const console = await store.saveText('console', consoleText, meta);
    return [network.id, console.id];
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    this.context.off('request', this.request); this.context.off('response', this.response); this.context.off('requestfailed', this.failed); this.context.off('console', this.console);
  }
}
