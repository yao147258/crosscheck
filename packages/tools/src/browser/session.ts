import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type { Writable, Readable } from 'node:stream';
import { chromium, type Browser } from 'playwright';
import { LocalForwardProxy } from './network-proxy';
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

function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } }
}

export async function launchGuardedChromium(options: LaunchOptions): Promise<GuardedBrowser> {
  await mkdir(options.userDataDir, { recursive: true });
  const executable = options.executablePath ?? chromium.executablePath();
  let proc: ChildProcess | undefined;
  let mux: GuardedCdpMux | undefined;
  let closing = false;
  let fatalReason: string | undefined;
  let closePromise: Promise<void> | undefined;
  const proxy = new LocalForwardProxy({ allowedHosts: options.allowedHosts, onFatal(reason) {
    if (!closing) fatalReason ??= reason;
    if (proc) killTree(proc);
    void close();
  } });
  let exited: Promise<void> = Promise.resolve();
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      // 保留守卫与调试 pipe 直到整个进程树终止，不能先断连释放暂停 target。
      if (proc) killTree(proc);
      await exited;
      mux?.shutdown('会话关闭', false);
      await proxy.stop();
    })();
    return closePromise;
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
    child.on('error', () => { if (!closing) { fatalReason ??= '浏览器进程故障'; void close(); } });
    child.once('exit', () => { if (!closing) { fatalReason ??= '浏览器意外退出'; void close(); } });
    mux = new GuardedCdpMux(pipeChannel(child), {
      ...options.guard,
      onFatal(reason) { if (!closing) fatalReason ??= reason; killTree(child); void close(); },
    });
    await mux.init();
    const browser = await chromium.connectOverCDP(mux.playwrightTransport());
    return { browser, mux, process: child, close, exited, get fatalReason() { return fatalReason; } };
  } catch (error) {
    await close();
    throw error;
  }
}
