import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { scriptedModel } from '../../agent/src/testing/scripted-model';
import { sessionCommand } from '../../cli/src/session';
import { SessionStore } from '../../cli/src/session-store';
import { readUsage } from '../../models/src/usage-ledger';
import * as tui from '../src/index';
import { SessionApp } from '../src/session';
import { cleanupProjects, createProject } from './fixture';
import { KEYS, waitFor } from './helpers';

const exit = vi.hoisted(() => vi.fn());
vi.mock('ink', async (importOriginal) => {
  const ink = await importOriginal<typeof import('ink')>();
  return { ...ink, useApp: () => ({ ...ink.useApp(), exit }) };
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  exit.mockReset();
  await cleanupProjects();
});

it('重新启动交互宿主后只读恢复历史和原用量 ID，下一轮继续原上下文', async () => {
  const { root, userHome } = await createProject();
  const beforeRestart = scriptedModel([{ text: '第一轮回答' }]);
  const afterRestart = scriptedModel([{ text: '恢复后的回答' }]);
  const launch = vi.spyOn(tui, 'runSession').mockResolvedValue(0);
  const loadStatus = vi.spyOn(tui, 'loadStatus');
  const start = async (model: ReturnType<typeof scriptedModel>) => {
    await sessionCommand({ command: 'session', project: root, open: false }, () => {}, {
      userConfigHome: userHome,
      session: { isTTY: true },
      modelOptions: { factories: { openai: () => model } },
    });
    const ui = render(<SessionApp options={{ ...launch.mock.lastCall![0], mouseTracking: undefined }} />);
    Object.defineProperty(ui.stdout, 'rows', { value: 60 });
    ui.stdout.emit('resize');
    const frame = () => ui.lastFrame() ?? '';
    const id = () => /会话 ID：([a-f0-9-]{36})/.exec(frame())?.[1];
    const send = (text: string) => { ui.stdin.write(text); ui.stdin.write(KEYS.enter); };
    const idle = (text: string) => waitFor(() => frame().includes(text) && !frame().includes('Ctrl+C 中断'));
    await waitFor(() => Boolean(id()));
    return { ui, frame, id, send, idle };
  };
  const store = new SessionStore(root, userHome);
  const first = await start(beforeRestart);
  const originalId = first.id()!;
  first.send('第一轮问题');
  await first.idle('第一轮回答');
  first.send('/status');
  await first.idle('退出码 0');
  expect(loadStatus).toHaveBeenCalledTimes(1);
  const original = await store.load(originalId);
  expect(original?.revision).toBe(4);
  expect((await readUsage({ project: root, home: userHome, sessionId: originalId })).total.calls).toBe(1);
  first.send('/exit');
  await waitFor(() => exit.mock.calls.length === 1);
  first.ui.unmount();

  const second = await start(afterRestart);
  const freshId = second.id()!;
  expect(freshId).not.toBe(originalId);
  expect(second.frame()).not.toContain('第一轮回答');
  second.send(`/resume ${originalId}`);
  await second.idle('调用 1');
  expect(second.id()).toBe(originalId);
  expect(loadStatus).toHaveBeenCalledTimes(1);
  expect(second.frame()).toContain('第一轮回答');
  expect(second.frame()).toContain('/status');
  expect(afterRestart.doGenerateCalls).toHaveLength(0);
  expect(await store.load(originalId)).toEqual(original);
  expect(await store.load(freshId)).toBeNull();
  expect((await readUsage({ project: root, home: userHome, sessionId: originalId })).total.calls).toBe(1);

  second.send('恢复后的问题');
  await second.idle('恢复后的回答');
  expect(afterRestart.doGenerateCalls).toHaveLength(1);
  expect(afterRestart.doGenerateCalls[0]!.prompt.slice(1)).toEqual([
    { role: 'user', content: [{ type: 'text', text: '第一轮问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第一轮回答' }] },
    { role: 'user', content: [{ type: 'text', text: '恢复后的问题' }] },
  ]);
  expect((await readUsage({ project: root, home: userHome, sessionId: originalId })).total.calls).toBe(2);
  expect((await readUsage({ project: root, home: userHome, sessionId: freshId })).total.calls).toBe(0);
  expect(await store.load(freshId)).toBeNull();
  expect(await store.load(originalId)).toMatchObject({ revision: 6, history: [
    { role: 'user', content: '第一轮问题' },
    { role: 'assistant', content: '第一轮回答' },
    { role: 'user', content: '恢复后的问题' },
    { role: 'assistant', content: '恢复后的回答' },
  ] });
});
