import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type { Writable, Readable } from 'node:stream';
import { chromium, type Browser } from 'playwright';
import { LocalForwardProxy, type ProxyAuditEvent } from './network-proxy';
import { GuardedCdpMux, type CdpChannel, type CdpMessage, type GuardOptions } from './request-guard';

/** 与 Playwright 1.65 默认 Chromium 参数保持一致的子集，外加安全相关参数。 */
const BASE_ARGS = [
  '--disable-field-trial-config', '--disable-background-networking', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-back-forward-cache', '--disable-breakpad',
  '--disable-component-extensions-with-background-pages', '--disable-component-update', '--no-default-browser-check',
  '--disable-default-apps', '--disable-dev-shm-usage', '--disable-extensions',
  '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,TcpPortRandomizationWin,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,PreconnectToSearch,WebTransport',
  '--enable-features=CDPScreenshotNewSurface,SkipListAccountsWithoutGaiaCookies',
  '--allow-pre-commit-input', '--disable-hang-monitor', '--disable-ipc-flooding-protection', '--disable-popup-blocking',
  '--disable-prompt-on-repost', '--disable-renderer-backgrounding', '--force-color-profile=srgb', '--metrics-recording-only',
  '--no-first-run', '--password-store=basic', '--use-mock-keychain', '--no-service-autorun', '--disable-search-engine-choice-screen',
  '--enable-unsafe-swiftshader', '--disable-stack-profiler', '--disable-infobars', '--disable-sync', '--do-not-de-elevate',
  // 每个跨站 iframe 独立进程，确保 OOPIF 路径被实际覆盖
  '--site-per-process',
];

export interface LaunchOptions {
  allowedHosts: string[];
  /** 宿主安全审计，仅接收主机、端口和结果；回调抛错触发统一清理。 */
  onProxyEvent?(event: ProxyAuditEvent): void;
  executablePath?: string;
  /** 必须位于本次 run 的 .crosscheck 临时子目录 */
  userDataDir: string;
  headless?: boolean;
  guard: Omit<GuardOptions, 'onFatal'>;
}

export interface GuardedBrowser {
  browser: Browser;
  mux: GuardedCdpMux;
  process: ChildProcess;
  /** 幂等：关闭 Playwright、CDP 并杀掉整个浏览器进程树 */
  close(): Promise<void>;
  readonly exited: Promise<void>;
  readonly fatalReason: string | undefined;
}

function pipeChannel(proc: ChildProcess): CdpChannel {
  const writer = proc.stdio[3] as Writable;
  const reader = proc.stdio[4] as Readable;
  const channel: CdpChannel = {
    send(message: CdpMessage) { writer.write(JSON.stringify(message) + '\0'); },
    close() { writer.destroy(); reader.destroy(); },
  };
  let buffered = '';
  reader.setEncoding('utf8');
  reader.on('data', (chunk: string) => {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf('\0')) !== -1) {
      const raw = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      let parsed: CdpMessage;
      try { parsed = JSON.parse(raw) as CdpMessage; } catch { channel.onclose?.('CDP 消息无法解析'); return; }
      channel.onmessage?.(parsed);
    }
  });
  const closed = () => channel.onclose?.('pipe 关闭');
  reader.on('close', closed);
  reader.on('error', closed);
  writer.on('error', closed);
  return channel;
}

const CLEANUP_TIMEOUT_MS = 5000;

function bounded<T>(operation: Promise<T>, reason: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), CLEANUP_TIMEOUT_MS);
    operation.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

async function terminateTree(proc: ChildProcess): Promise<void> {
  if (proc.pid === undefined) return; // spawn 未成功，没有受控进程。
  if (process.platform === 'win32') {
    // 已退出 PID 可能被重用；没有 Job Object 就无法可靠追踪后代，不能误杀或假报成功。
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error('Windows 后代进程所有权未建立，无法确认清理');
    await bounded(new Promise<void>((resolve, reject) => {
      execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { timeout: CLEANUP_TIMEOUT_MS, windowsHide: true }, (error) => {
        if (error) reject(new Error('浏览器进程树终止失败'));
        else resolve();
      });
    }), '浏览器进程树终止超时');
    return;
  }
  // detached 启动的进程组身份不依赖主进程是否已经退出，不能回退为仅杀根进程。
  const group = -proc.pid;
  try { process.kill(group, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('浏览器进程组终止失败'); }
  await bounded(new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
    const probe = () => {
      if (Date.now() >= deadline) { reject(new Error('浏览器进程组退出确认超时')); return; }
      try { process.kill(group, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { resolve(); return; } reject(new Error('无法核验浏览器进程组')); return; }
      const timer = setTimeout(probe, 25); timer.unref();
    };
    probe();
  }), '浏览器进程组退出确认超时');
}

export async function launchGuardedChromium(options: LaunchOptions): Promise<GuardedBrowser> {
  await mkdir(options.userDataDir, { recursive: true });
  const executable = options.executablePath ?? chromium.executablePath();
  let proc: ChildProcess | undefined;
  let mux: GuardedCdpMux | undefined;
  let closing = false;
  let fatalReason: string | undefined;
  let closePromise: Promise<void> | undefined;
  const proxy = new LocalForwardProxy({ allowedHosts: options.allowedHosts, onEvent: options.onProxyEvent, onFatal(reason) {
    fatalReason ??= reason;
    return close();
  } });
  let exited: Promise<void> = Promise.resolve();
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => termination ??= (async () => {
    if (proc) await terminateTree(proc);
    await bounded(exited, '浏览器退出等待超时');
  })();
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      try {
        // 先停止转发但保留 pipe；mux 的回调只等待 terminate，不反向调用 close。
        const shutting = mux?.shutdown('会话关闭');
        await terminate();
        await shutting;
      } catch (error) {
        fatalReason = '浏览器清理失败：' + (error instanceof Error ? error.message : '终止未确认');
        throw error;
      } finally { await proxy.stop(); }
    })();
    return closePromise;
  };
  const fault = (reason: string) => {
    fatalReason ??= reason;
    void close().catch(() => {}); // 失败通过 fatalReason、close 拒绝显式保留，事件回调不能逃逸。
  };
  try {
    const proxyPort = await proxy.start();
    const args = [...BASE_ARGS, `--user-data-dir=${options.userDataDir}`, '--remote-debugging-pipe', '--no-startup-window',
      `--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>', '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
    if (options.headless !== false) args.push('--headless', '--hide-scrollbars', '--mute-audio');
    proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    const child = proc;
    child.stderr?.resume();
    exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.on('error', () => { if (!closing) fault('浏览器进程故障'); });
    child.once('exit', () => { if (!closing) fault('浏览器意外退出'); });
    mux = new GuardedCdpMux(pipeChannel(child), {
      ...options.guard,
      async onFatal(reason) {
        if (!closing) fatalReason ??= reason;
        closing = true;
        try { await terminate(); }
        catch (error) { fatalReason = '浏览器清理失败：' + (error instanceof Error ? error.message : '终止未确认'); throw error; }
        finally { await proxy.stop(); }
      },
    });
    await mux.init();
    const browser = await chromium.connectOverCDP(mux.playwrightTransport());
    return { browser, mux, process: child, close, exited, get fatalReason() { return fatalReason; } };
  } catch (error) {
    await close();
    throw error;
  }
}
