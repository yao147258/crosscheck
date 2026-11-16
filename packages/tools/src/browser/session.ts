import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type { Writable, Readable } from 'node:stream';
import { chromium, type Browser } from 'playwright';
import { GuardedCdpMux, type CdpChannel, type CdpMessage, type GuardOptions } from './request-guard';

/** 与 Playwright 1.65 默认 Chromium 参数保持一致的子集，外加安全相关参数。 */
const BASE_ARGS = [
  '--disable-field-trial-config', '--disable-background-networking', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-back-forward-cache', '--disable-breakpad',
  '--disable-component-extensions-with-background-pages', '--disable-component-update', '--no-default-browser-check',
  '--disable-default-apps', '--disable-dev-shm-usage', '--disable-extensions',
  '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,TcpPortRandomizationWin,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,PreconnectToSearch',
  '--enable-features=CDPScreenshotNewSurface,SkipListAccountsWithoutGaiaCookies',
  '--allow-pre-commit-input', '--disable-hang-monitor', '--disable-ipc-flooding-protection', '--disable-popup-blocking',
  '--disable-prompt-on-repost', '--disable-renderer-backgrounding', '--force-color-profile=srgb', '--metrics-recording-only',
  '--no-first-run', '--password-store=basic', '--use-mock-keychain', '--no-service-autorun', '--disable-search-engine-choice-screen',
  '--enable-unsafe-swiftshader', '--disable-stack-profiler', '--disable-infobars', '--disable-sync', '--do-not-de-elevate',
  // 每个跨站 iframe 独立进程，确保 OOPIF 路径被实际覆盖
  '--site-per-process',
];

export interface LaunchOptions {
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
  const args = [...BASE_ARGS, `--user-data-dir=${options.userDataDir}`, '--remote-debugging-pipe', '--no-startup-window'];
  if (options.headless !== false) args.push('--headless', '--hide-scrollbars', '--mute-audio');
  const proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  proc.stderr?.resume();
  const exited = new Promise<void>((resolve) => { if (proc.exitCode !== null) resolve(); else proc.once('exit', () => resolve()); });
  let fatalReason: string | undefined;
  const mux = new GuardedCdpMux(pipeChannel(proc), {
    ...options.guard,
    onFatal(reason) { fatalReason ??= reason; killTree(proc); },
  });
  let browser: Browser | undefined;
  const close = async () => {
    // 先断开 Playwright，再关闭 CDP，最后确保进程树终止
    await browser?.close().catch(() => {});
    mux.shutdown('会话关闭');
    killTree(proc);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  };
  try {
    await mux.init();
    browser = await chromium.connectOverCDP(mux.playwrightTransport());
  } catch (error) {
    await close();
    throw error;
  }
  return { browser, mux, process: proc, close, exited, get fatalReason() { return fatalReason; } };
}
