import type { Browser, BrowserContext, Page } from 'playwright';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}
/** 启动失败不等于清理成功；宿主必须保留并传播此错误。 */
export class BrowserCleanupError extends Error {
  constructor(readonly failures: unknown[]) { super('浏览器资源清理失败'); }
}

/** 启动每阶段都监听取消，取得迟到资源后仍登记并等待清理；launch 本身有明确期限。 */
export async function launchBrowserSession(options: { signal: AbortSignal; headless?: boolean }): Promise<BrowserSession> {
  options.signal.throwIfAborted();
  let browser: Browser | undefined, context: BrowserContext | undefined, stopped = false;
  let finalClose: Promise<void> | undefined;
  const pending: Promise<void>[] = [], failures: unknown[] = [];
  const seen = new WeakSet<object>();
  const dispose = (resource: Browser | BrowserContext | undefined): Promise<void> => {
    if (!resource || seen.has(resource)) return Promise.resolve();
    seen.add(resource);
    const task = Promise.resolve().then(() => resource.close()).catch(error => { failures.push(error); });
    pending.push(task); return task;
  };
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopped = true;
    // 正常 context 关闭完成后才关闭 browser，避免并行销毁制造假的关闭失败。
    stopping ??= dispose(context).then(() => dispose(browser));
    pending.push(stopping);
  };
  const drain = async () => {
    let length = -1;
    while (length !== pending.length) { length = pending.length; await Promise.all(pending); }
    if (failures.length) throw new BrowserCleanupError([...failures]);
  };
  const close = (): Promise<void> => finalClose ??= (async () => {
    options.signal.removeEventListener('abort', stop); stop(); await drain();
  })();
  const check = () => { if (stopped || options.signal.aborted) throw new Error('浏览器启动已取消'); };
  options.signal.addEventListener('abort', stop, { once: true });
  try {
    const { chromium } = await import('playwright');
    check();
    browser = await chromium.launch({ headless: options.headless ?? true, timeout: 10000 });
    if (stopped) dispose(browser); check();
    context = await browser.newContext({ acceptDownloads: false });
    if (stopped) dispose(context); check();
    const page = await context.newPage();
    check();
    return { browser, context, page, close };
  } catch (error) {
    options.signal.removeEventListener('abort', stop);
    stop(); await drain(); throw error;
  }
}
