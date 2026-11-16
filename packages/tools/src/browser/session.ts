import type { Browser, BrowserContext, Page } from 'playwright';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/** 每用例独立的标准 Playwright 会话，不安装页面网络策略。 */
export async function launchBrowserSession(options: { signal: AbortSignal; headless?: boolean }): Promise<BrowserSession> {
  options.signal.throwIfAborted();
  let browser: Browser | undefined, context: BrowserContext | undefined, closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    options.signal.removeEventListener('abort', abort);
    try { await context?.close(); } finally { await browser?.close(); }
  })();
  // 事件不能 await；保留同一个清理 promise，由启动路径和宿主 close 等待并传播失败。
  const abort = () => { close().catch(() => {}); };
  try {
    const { chromium } = await import('playwright');
    options.signal.throwIfAborted();
    browser = await chromium.launch({ headless: options.headless ?? true });
    options.signal.throwIfAborted();
    context = await browser.newContext({ acceptDownloads: false });
    options.signal.throwIfAborted();
    const page = await context.newPage();
    options.signal.throwIfAborted();
    options.signal.addEventListener('abort', abort, { once: true });
    return { browser, context, page, close };
  } catch (error) { await close(); throw error; }
}
