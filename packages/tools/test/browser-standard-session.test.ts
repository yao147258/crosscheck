import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch: state.launch } }));
import { launchBrowserSession } from '../src/browser/session';
beforeEach(() => vi.clearAllMocks());
describe('标准会话生命周期', () => {
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
    await expect(session.close()).rejects.toThrow('关闭失败'); await expect(session.close()).rejects.toThrow('关闭失败'); expect(count).toBe(1);
  });
});
