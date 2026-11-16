import { z } from 'zod';
import type { Locator, Page } from 'playwright';
import { EnvRefSchema, TraceLocatorSchema } from '@crosscheck/core';
import type { EvidenceStore } from '../evidence/store';
import type { EvidenceRedactor } from '../evidence/redactor';
import type { EvidenceMeta } from '../network/http-client';
import { launchBrowserSession, type BrowserSession } from './session';
import { capturePage } from './capture';
import { BrowserEvents } from './events';

type Role = Parameters<Page['getByRole']>[0];
const roles = ['alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem'] as const satisfies readonly Role[];
const locatorSchema = TraceLocatorSchema.refine(l => l.strategy !== 'role' || (roles as readonly string[]).includes(l.value), '角色不合法');
export const BrowserActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('navigate'), url: z.string().min(1).max(8192) }),
  z.strictObject({ kind: z.literal('click'), locator: locatorSchema }),
  z.strictObject({ kind: z.literal('observe'), locator: locatorSchema.optional() }),
  z.strictObject({ kind: z.literal('fill'), locator: locatorSchema, value: z.string().max(65536).optional(), env: EnvRefSchema.optional() }).refine(a => (a.value !== undefined) !== (a.env !== undefined), 'fill 必须且只能指定 value 或 env'),
  z.strictObject({ kind: z.literal('select'), locator: locatorSchema, values: z.array(z.string().max(4096)).max(100) }),
  z.strictObject({ kind: z.literal('press'), locator: locatorSchema, key: z.string().min(1).max(100) }),
  z.strictObject({ kind: z.literal('wait'), locator: locatorSchema, state: z.enum(['visible', 'hidden', 'attached', 'detached']) }),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export type TraceLocator = z.infer<typeof TraceLocatorSchema>;
export class BrowserOperationError extends Error {
  constructor(readonly kind: 'blocked' | 'cancelled' | 'browser', message: string, readonly evidenceIds: string[]) { super(message); }
}
export interface BrowserHostOptions {
  baseURL: string;
  evidence: EvidenceStore;
  redactor: EvidenceRedactor;
  screenshotMasks?: string[];
  env?: Record<string, string | undefined>;
  launch?: typeof launchBrowserSession;
}
function locate(page: Page, locator: TraceLocator): Locator {
  switch (locator.strategy) {
    case 'css': return page.locator(`css=${locator.value}`);
    case 'xpath': return page.locator(`xpath=${locator.value}`);
    case 'role': return page.getByRole(locator.value as Role, { name: locator.name, exact: true });
    case 'text': return page.getByText(locator.value, { exact: true });
    case 'testId': return page.getByTestId(locator.value);
  }
}
/** 宿主拥有惰性会话；动作串行，取消会关闭整个 case 会话，不自动重放业务动作。 */
export class BrowserHost {
  private session?: Promise<BrowserSession>;
  private events?: BrowserEvents;
  private closing?: Promise<void>;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly signals = new Map<AbortSignal, () => void>();
  private lastMeta?: EvidenceMeta;
  constructor(private readonly options: BrowserHostOptions) {}
  private bind(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.signals.has(signal)) return;
    const abort = () => { this.close().catch(() => {}); };
    this.signals.set(signal, abort); signal.addEventListener('abort', abort, { once: true });
  }
  async getSession(signal: AbortSignal): Promise<BrowserSession> {
    if (signal.aborted) {
      if (this.session) { const session = await this.session; await session.close(); }
      this.closed = true;
      throw new BrowserOperationError('cancelled', '浏览器会话已取消', []);
    }
    if (this.closed) throw new BrowserOperationError('cancelled', '浏览器会话已关闭', []);
    this.bind(signal);
    this.session ??= (this.options.launch ?? launchBrowserSession)({ signal }).then(async session => {
      if (this.closed || signal.aborted) { await session.close(); throw new BrowserOperationError('cancelled', '浏览器会话已取消', []); }
      session.context.setDefaultTimeout(5000); session.context.setDefaultNavigationTimeout(10000);
      this.events = new BrowserEvents(session.context, this.options.redactor);
      return session;
    });
    return this.session;
  }
  perform(input: BrowserAction, meta: EvidenceMeta, signal: AbortSignal): Promise<{ evidenceIds: string[]; summary: unknown }> {
    const task = this.tail.then(() => this.performOne(input, meta, signal));
    this.tail = task.then(() => {}, () => {});
    return task;
  }
  private async performOne(input: BrowserAction, meta: EvidenceMeta, signal: AbortSignal) {
    const evidenceIds: string[] = [], parsed = BrowserActionSchema.safeParse(input);
    if (!parsed.success) throw new BrowserOperationError('blocked', '浏览器动作输入不合法', []);
    const action = parsed.data;
    let url: string | undefined, fill: string | undefined;
    if (action.kind === 'navigate') {
      try {
        const target = new URL(action.url, this.options.baseURL);
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error();
        url = target.href;
      } catch { throw new BrowserOperationError('blocked', '导航只支持 HTTP(S) 或相对地址', []); }
    }
    if (action.kind === 'fill') {
      fill = action.env ? (this.options.env ?? process.env)[action.env] : action.value;
      if (fill === undefined) throw new BrowserOperationError('blocked', '所需环境变量未提供', []);
      // 普通 fill 也登记，避免错误消息、页面回显和网络反射泄漏原始输入。
      this.options.redactor.addSecrets([fill]);
    }
    let session: BrowserSession;
    try { session = await this.getSession(signal); }
    catch { throw new BrowserOperationError(signal.aborted ? 'cancelled' : 'browser', '浏览器启动失败或已取消（原始诊断已省略）', evidenceIds); }
    this.lastMeta = { ...meta };
    const capture = async () => {
      let observed: Awaited<ReturnType<typeof capturePage>>;
      try { observed = await capturePage(session.page, this.options.redactor, this.options.screenshotMasks); }
      catch { throw new BrowserOperationError(signal.aborted ? 'cancelled' : 'browser', '页面采证失败（原始诊断已省略）', evidenceIds); }
      evidenceIds.push((await this.options.evidence.saveDom(observed.dom, meta)).id);
      evidenceIds.push((await this.options.evidence.saveScreenshot(observed.screenshot, meta)).id);
    };
    let failure: unknown;
    try { await capture(); }
    catch (error) { await this.events!.flush(this.options.evidence, meta); throw error; }
    try {
      signal.throwIfAborted();
      switch (action.kind) {
        case 'navigate': await session.page.goto(url!, { waitUntil: 'domcontentloaded' }); break;
        case 'click': await locate(session.page, action.locator).click(); break;
        case 'fill': await locate(session.page, action.locator).fill(fill!); break;
        case 'select': await locate(session.page, action.locator).selectOption(action.values); break;
        case 'press': await locate(session.page, action.locator).press(action.key); break;
        case 'wait': await locate(session.page, action.locator).waitFor({ state: action.state }); break;
        case 'observe': if (action.locator) await locate(session.page, action.locator).waitFor({ state: 'attached' }); break;
      }
    } catch (error) { failure = error; }
    try { if (!session.page.isClosed()) await capture(); }
    catch (error) {
      if (!signal.aborted || !(error instanceof BrowserOperationError)) { await this.events!.flush(this.options.evidence, meta); throw error; }
      failure ??= error;
    }
    evidenceIds.push(...await this.events!.flush(this.options.evidence, meta));
    if (signal.aborted) { await session.close(); throw new BrowserOperationError('cancelled', '浏览器操作已取消', evidenceIds); }
    if (failure) throw new BrowserOperationError('browser', `浏览器 ${action.kind} 操作或采证失败（原始诊断已省略）`, evidenceIds);
    return { evidenceIds, summary: { kind: action.kind, url: this.options.redactor.url(session.page.url()), status: 'success' } };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const [signal, abort] of this.signals) signal.removeEventListener('abort', abort);
      this.signals.clear();
      let session: BrowserSession | undefined;
      try {
        try { session = await this.session; } catch { /* 启动失败路径自行清理部分资源。 */ }
        await session?.close();
        await this.tail;
        if (this.events && this.lastMeta) await this.events.flush(this.options.evidence, this.lastMeta);
      } finally { this.events?.close(); }
    })();
    return this.closing;
  }
}
