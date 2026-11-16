import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch: state.launch } }));
import { launchBrowserSession } from '../src/browser/session';
beforeEach(() => vi.clearAllMocks());
describe('标准会话生命周期', () => {
  it.each(['newContext', 'newPage'] as const)('R6 %s 悬挂时取消立即关闭已取得资源', async phase => {
    const controller = new AbortController(); let browserClosed = false, contextClosed = false;
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const context = { newPage: () => { entered(); return pending; }, close: async () => { contextClosed = true; finish({}); } };
    const browser = { newContext: () => { if (phase === 'newContext') { entered(); return pending; } return Promise.resolve(context); }, close: async () => { browserClosed = true; finish(context); } };
    state.launch.mockResolvedValue(browser);
    const task = launchBrowserSession({ signal: controller.signal }); const result = expect(task).rejects.toThrow();
    await ready; controller.abort();
    let immediate = false;
    try { await vi.waitFor(() => expect(browserClosed).toBe(true), { timeout: 200 }); immediate = true; }
    catch { /* 先释放测试闸门，避免失败断言遗留 pending。 */ }
    finally { finish(phase === 'newContext' ? context : {}); }
    await result; expect(immediate).toBe(true); expect(contextClosed).toBe(true);
  });
  it('R6 launch 显式期限且取消后的迟到资源也关闭', async () => {
    const controller = new AbortController(); let finish!: (value: unknown) => void, entered!: () => void, closed = false;
    const ready = new Promise<void>(r => { entered = r; });
    let timeout: number | undefined;
    state.launch.mockImplementation((options: { timeout: number }) => { timeout = options.timeout; entered(); return new Promise(r => { finish = r; }); });
    const task = launchBrowserSession({ signal: controller.signal }); const rejected = expect(task).rejects.toThrow();
    await ready; controller.abort(); finish({ close: async () => { closed = true; } });
    await rejected; expect(closed).toBe(true); expect(timeout).toBeGreaterThan(0); expect(timeout).toBeLessThanOrEqual(10000);
  });
  it('R5 newPage 失败后 browser 清理失败返回明确清理错误而非普通启动错误', async () => {
    state.launch.mockResolvedValue({ newContext: async () => ({ newPage: async () => { throw new Error('创建失败'); }, close: async () => {} }), close: async () => { throw new Error('资源未关闭'); } });
    await expect(launchBrowserSession({ signal: new AbortController().signal })).rejects.toMatchObject({ failures: [expect.objectContaining({ message: '资源未关闭' })] });
  });
  it('新页面启动失败也关闭已创建的 context 和 browser', async () => {
    let contextClosed = false, browserClosed = false;
    state.launch.mockResolvedValue({ newContext: async (options: unknown) => { expect(options).toEqual({ acceptDownloads: false }); return { newPage: async () => { throw new Error('页面创建失败'); }, close: async () => { contextClosed = true; } }; }, close: async () => { browserClosed = true; } });
    await expect(launchBrowserSession({ signal: new AbortController().signal })).rejects.toThrow('页面创建失败');
    expect(contextClosed).toBe(true); expect(browserClosed).toBe(true);
  });
  it('启动期间取消仍 await 部分资源清理；已取消不启动', async () => {
    const controller = new AbortController(); let closed = false;
    state.launch.mockImplementation(async () => { controller.abort(); return { close: async () => { closed = true; } }; });
    await expect(launchBrowserSession({ signal: controller.signal })).rejects.toThrow(); expect(closed).toBe(true);
    state.launch.mockClear(); await expect(launchBrowserSession({ signal: controller.signal })).rejects.toThrow(); expect(state.launch).not.toHaveBeenCalled();
  });
  it('context close 拒绝仍关闭 browser，幂等保留清理失败', async () => {
    let count = 0;
    state.launch.mockResolvedValue({ newContext: async () => ({ newPage: async () => ({}), close: async () => { throw new Error('关闭失败'); } }), close: async () => { count++; } });
    const session = await launchBrowserSession({ signal: new AbortController().signal });
    await expect(session.close()).rejects.toMatchObject({ failures: [expect.objectContaining({ message: '关闭失败' })] }); await expect(session.close()).rejects.toMatchObject({ failures: [expect.objectContaining({ message: '关闭失败' })] }); expect(count).toBe(1);
  });
});
