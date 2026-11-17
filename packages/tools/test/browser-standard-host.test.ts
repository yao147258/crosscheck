import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BrowserHost } from '../src/browser/actions';
import { BrowserCleanupError } from '../src/browser/session';
import { createEvidenceRedactor } from '../src/evidence/redactor';
import type { EvidenceStore } from '../src/evidence/store';
import type { BrowserSession } from '../src/browser/session';
import * as capture from '../src/browser/capture';

const meta = { actionId: 'a-1', phase: 'execution' as const };
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(close: () => Promise<void>) {
  const context = Object.assign(new EventEmitter(), { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, cookies: async () => [] });
  const store = { saveHar: vi.fn(async () => ({ id: 'network' })), saveText: vi.fn(async () => ({ id: 'console' })), saveDom: vi.fn(async () => ({ id: 'dom' })), saveScreenshot: vi.fn(async () => ({ id: 'png' })) };
  const page = { isClosed: () => false, url: () => 'http://localhost/', locator: () => ({ click: async () => {} }) };
  const session = { context, page, close } as unknown as BrowserSession;
  const host = new BrowserHost({ baseURL: 'http://localhost/', redactor: createEvidenceRedactor(), evidence: store as unknown as EvidenceStore, launch: async () => session });
  return { host, store, context };
}
describe('浏览器宿主失败收尾', () => {
  it.each([1, 2])('R8 第 %s 次采证失败保留成功 flush 的所有 ID', async failAt => {
    let n = 0;
    const spy = vi.spyOn(capture, 'capturePage').mockImplementation(async () => { if (++n === failAt) throw new Error('页面切换'); return { dom: [], screenshot: { kind: 'masked-capture' } }; });
    const f = fixture(async () => {});
    try {
      await expect(f.host.perform({ kind: 'click', locator: { strategy: 'css', value: '#x' } }, meta, new AbortController().signal)).rejects.toMatchObject({ evidenceIds: failAt === 1 ? ['network', 'console'] : ['dom', 'png', 'network', 'console'] });
    } finally { spy.mockRestore(); await f.host.close(); }
  });
  it('R4 前置取消必须等待延迟 session.close，且不自等待 tail', async () => {
    const entered = gate(), closed = gate(), failCapture = gate(); let finished = false;
    const f = fixture(async () => { failCapture.resolve(); await closed.promise; finished = true; });
    const spy = vi.spyOn(capture, 'capturePage').mockImplementation(async () => { entered.resolve(); await failCapture.promise; throw new Error('页面关闭'); });
    const controller = new AbortController(); let returned = false;
    const task = f.host.perform({ kind: 'observe' }, meta, controller.signal).catch(error => { returned = true; return error; });
    try {
      await entered.promise; controller.abort(); await vi.waitFor(() => expect(f.store.saveHar).toHaveBeenCalled());
      expect(returned).toBe(false); closed.resolve();
      expect(await task).toMatchObject({ kind: 'cancelled', evidenceIds: ['network', 'console'] }); expect(finished).toBe(true);
    } finally { closed.resolve(); await task; spy.mockRestore(); await f.host.close(); }
  });
  it('R5 启动半成品清理失败不能降级，getSession/perform/close 都保留', async () => {
    const failure = new BrowserCleanupError([new Error('未收拢资源')]);
    const host = new BrowserHost({ baseURL: 'http://localhost/', evidence: {} as EvidenceStore, redactor: createEvidenceRedactor(), launch: async () => { throw failure; } });
    await expect(host.getSession(new AbortController().signal)).rejects.toBe(failure);
    await expect(host.perform({ kind: 'observe' }, meta, new AbortController().signal)).rejects.toBe(failure);
    await expect(host.close()).rejects.toBe(failure);
  });
  it('R7 close 失败仍等待动作尾部、flush、解绑，最后传播失败', async () => {
    const failure = new BrowserCleanupError([new Error('关闭拒绝')]), observed = gate(), finishCapture = gate();
    const f = fixture(async () => { throw failure; }); let n = 0;
    const spy = vi.spyOn(capture, 'capturePage').mockImplementation(async () => { if (++n === 2) { observed.resolve(); await finishCapture.promise; } return { dom: [], screenshot: { kind: 'masked-capture' } }; });
    const task = f.host.perform({ kind: 'observe' }, meta, new AbortController().signal);
    await observed.promise; let returned = false;
    const closing = f.host.close().catch(e => { returned = true; return e; });
    try {
      await new Promise<void>(r => setImmediate(r)); expect(returned).toBe(false);
      finishCapture.resolve(); await task;
      expect(await closing).toBe(failure); expect(f.store.saveHar).toHaveBeenCalledTimes(2); expect(f.context.listenerCount('console')).toBe(0);
    } finally { finishCapture.resolve(); await task; await closing; spy.mockRestore(); }
  });
});
