/** 操作系统终止失败只在边界注入；真实进程树所有权仍须独立平台验收。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ child: undefined as any, kill: undefined as any, proxy: undefined as any, spawnArgs: [] as string[] }));
vi.mock('node:child_process', () => ({
  spawn(_exe: string, args: string[]) { state.spawnArgs = args; queueMicrotask(() => state.child.emit('spawn')); return state.child; },
  spawnSync() { return { status: 0 }; },
  execFile(_exe: string, _args: string[], options: unknown, callback: (...args: any[]) => void) { state.kill(options, callback); },
}));
vi.mock('playwright', () => ({ chromium: { executablePath: () => 'test-chromium', connectOverCDP: async () => ({}) } }));
vi.mock('../src/browser/network-proxy', () => ({ LocalForwardProxy: class {
  constructor(readonly options: any) { state.proxy = this; }
  start = async () => 12345;
  stop = vi.fn(async () => {});
} }));
import { launchGuardedChromium } from '../src/browser/session';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function launch(onProxyEvent?: (event: any) => void) {
  const root = await mkdtemp(path.join(tmpdir(), 'cc-session-unit-')); roots.push(root);
  const reader = new PassThrough();
  const child: any = new EventEmitter(); child.pid = 314159; child.exitCode = null; child.signalCode = null; child.stderr = new PassThrough();
  const writer = new Writable({ write(chunk, _enc, done) { for (const raw of chunk.toString().split('\0').filter(Boolean)) {
    const m = JSON.parse(raw); queueMicrotask(() => reader.write(JSON.stringify({ id: m.id, result: {} }) + '\0'));
  } done(); } });
  child.stdio = [null, null, child.stderr, writer, reader]; state.child = child;
  const session = await launchGuardedChromium({ allowedHosts: ['127.0.0.1'], userDataDir: root, guard: { decide: () => ({ allow: true }) }, onProxyEvent });
  return { session, child, reader, writer };
}
function exitRoot(child = state.child) { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); }

describe.skipIf(process.platform !== 'win32')('会话 Win32 清理失败边界', () => {
  it('根进程先退出仍尝试清理，不能把根 close 当后代证明', async () => {
    let attempts = 0; state.kill = (_options: any, cb: any) => { attempts++; cb(null); };
    const { session, child, writer } = await launch(); exitRoot(child);
    await expect(session.close()).rejects.toThrow(/后代.*所有权/);
    // 已退出的 PID 可能重用，不能误杀无关进程；本轮明确保留 Windows 所有权阻碍。
    expect(attempts).toBe(0); expect(writer.destroyed).toBe(false); expect(state.proxy.stop).toHaveBeenCalled();
  });
  it('管道物理断开会记录原因并立即发起有界终止，不能声称未提前断连', async () => {
    let callback: any; state.kill = (_options: any, cb: any) => { callback = cb; };
    const { session, reader } = await launch(); reader.destroy();
    await new Promise<void>((r) => setImmediate(r));
    expect(session.fatalReason).toMatch(/CDP 连接断开/); expect(callback).toBeTypeOf('function');
    state.child.exitCode = 1; state.child.emit('exit', 1); state.child.emit('close', 1); callback(null);
    await session.close();
  });
  it('taskkill 非零明确拒绝，停止代理且保留 pipe', async () => {
    state.kill = (_options: any, cb: any) => cb(Object.assign(new Error('操作系统原始错误'), { code: 1 }));
    const { session, writer } = await launch();
    await expect(session.close()).rejects.toThrow(/进程树终止失败/);
    expect(writer.destroyed).toBe(false); expect(session.fatalReason).toMatch(/清理失败/); expect(state.proxy.stop).toHaveBeenCalled();
  });
  it('taskkill 挂起有超时，宿主等待有界，不假成功', async () => {
    let options: any; state.kill = (o: any) => { options = o; };
    const { session, writer } = await launch(); vi.useFakeTimers();
    const closing = session.close();
    expect(session.mux.isClosed).toBe(true);
    const result = expect(closing).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(11000); await result;
    expect(options.timeout).toBeGreaterThan(0); expect(options.timeout).toBeLessThanOrEqual(5000); expect(writer.destroyed).toBe(false);
  });
  it('taskkill 成功但主进程不退出也有界拒绝', async () => {
    state.kill = (_options: any, cb: any) => cb(null);
    const { session, writer } = await launch(); vi.useFakeTimers();
    const result = expect(session.close()).rejects.toThrow(/退出.*超时/); await vi.advanceTimersByTimeAsync(11000); await result;
    expect(writer.destroyed).toBe(false); expect(state.proxy.stop).toHaveBeenCalled();
  });
  it('taskkill 无法启动时同样明确拒绝并停止代理', async () => {
    state.kill = (_options: any, cb: any) => cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const { session, writer } = await launch();
    await expect(session.close()).rejects.toThrow(/进程树终止失败/);
    expect(writer.destroyed).toBe(false); expect(state.proxy.stop).toHaveBeenCalled();
  });
  it('POSIX 根进程先退出仍终止并核验原进程组', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('已退出'), { code: 'ESRCH' });
      return true;
    });
    const { session, child, writer } = await launch();
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' }); exitRoot(child);
      await session.close(); expect(kill.mock.calls).toEqual([[-314159, 'SIGKILL'], [-314159, 0]]); expect(writer.destroyed).toBe(true);
    } finally { Object.defineProperty(process, 'platform', descriptor); kill.mockRestore(); }
  });
  it('fatal 等待终止结果，不提前断 pipe；实际代理事件仅安全字段接线', async () => {
    let callback: any; state.kill = (_options: any, cb: any) => { callback = cb; };
    const events: unknown[] = []; const { session, writer } = await launch((event) => events.push(event));
    state.proxy.options.onEvent({ kind: 'blocked', hostname: '127.0.0.1', port: '123' });
    expect(events).toEqual([{ kind: 'blocked', hostname: '127.0.0.1', port: '123' }]);
    const pending = session.mux.shutdown('测试 fatal'); expect(writer.destroyed).toBe(false);
    state.child.exitCode = 1; state.child.emit('exit', 1); state.child.emit('close', 1); callback(null);
    await pending; expect(writer.destroyed).toBe(true); expect(session.fatalReason).toBe('测试 fatal');
  });
});
