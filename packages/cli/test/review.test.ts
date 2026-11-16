import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { RunReviewOptions } from '@crosscheck/tui';
import { cliMain } from '../src/main';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

it('非 TTY 时退出 2，不启动界面', async () => {
  const out: string[] = []; let started = false;
  const code = await cliMain(['review'], { log: (s) => out.push(s), dependencies: { review: { isTTY: false, runReview: async () => { started = true; return 0; } } } });
  expect(code).toBe(2); expect(started).toBe(false); expect(out.join('')).toContain('交互式终端');
});

it('无法确定确认人时退出 2', async () => {
  expect(await cliMain(['review'], { log: () => {}, dependencies: { env: { CROSSCHECK_REVIEWER: ' ' }, review: { isTTY: true, userInfo: () => ({ username: '' }), runReview: async () => 0 } } })).toBe(2);
});

it.each([
  { view: 'profile', extra: [], expected: { view: 'profile' } },
  { view: 'clauses', extra: ['--module', 'M'], expected: { view: 'clauses', module: 'M' } },
  { view: 'cases', extra: ['--module', 'M'], expected: { view: 'cases', module: 'M' } },
  { view: 'results', extra: ['--run', '20261116T000000000Z-00000000000000000000000000000000'], expected: { view: 'results', runId: '20261116T000000000Z-00000000000000000000000000000000' } },
])('传递 $view 视图与参数，环境确认人去空白且优先于系统用户名', async ({ view, extra, expected }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cli-review-')); roots.push(root);
  let received: RunReviewOptions | undefined;
  expect(await cliMain(['review', view, ...extra, '--project', root], {
    log: () => {}, dependencies: { env: { CROSSCHECK_REVIEWER: ' 王五 ', EDITOR: 'notepad' }, review: { isTTY: true, userInfo: () => ({ username: '系统用户' }), runReview: async (o) => { received = o; return 0; } } },
  })).toBe(0);
  expect(received).toMatchObject({ reviewer: '王五', ...expected });
  expect(received?.artifacts.root).toBe(path.join(root, '.crosscheck'));
  expect(received?.editor.edit).toBeTypeOf('function'); expect(received?.open).toBeTypeOf('function');
});

it('空白环境确认人回退系统用户名，保留界面退出码', async () => {
  let reviewer: string | undefined;
  expect(await cliMain(['review'], { log: () => {}, dependencies: { env: { CROSSCHECK_REVIEWER: ' ' }, review: { isTTY: true, userInfo: () => ({ username: ' 系统用户 ' }), runReview: async (o) => { reviewer = o.reviewer; return 2; } } } })).toBe(2);
  expect(reviewer).toBe('系统用户');
});

it('预取消不启动界面', async () => {
  let started = false;
  expect(await cliMain(['review'], { log: () => {}, signal: AbortSignal.abort(), dependencies: { review: { isTTY: true, runReview: async () => { started = true; return 0; } } } })).toBe(2);
  expect(started).toBe(false);
});

it.each(['external', 'SIGINT', 'SIGTERM'] as const)('转发 %s 取消，等待界面结束并恢复监听器', async (source) => {
  const controller = new AbortController();
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  let aborted = false;
  expect(await cliMain(['review'], { log: () => {}, signal: controller.signal, dependencies: { env: { CROSSCHECK_REVIEWER: '测试人' }, review: { isTTY: true, runReview: async (o) => {
    if (source === 'external') controller.abort(); else process.emit(source);
    aborted = o.signal?.aborted ?? false;
    return 0;
  } } } })).toBe(2);
  expect(aborted).toBe(true);
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
});

it('界面宿主错误并发取消仍退出 3', async () => {
  const controller = new AbortController(); const out: string[] = [];
  expect(await cliMain(['review'], { signal: controller.signal, log: (s) => out.push(s), dependencies: { env: { CROSSCHECK_REVIEWER: '测试人' }, review: { isTTY: true, runReview: async () => { controller.abort(); throw new Error('磁盘故障'); } } } })).toBe(3);
  expect(out.join('')).toContain('磁盘故障');
});
