import { PassThrough } from 'node:stream';
import { Approvals } from '@crosscheck/core';
import type { RenderOptions } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReview } from '../src/index';
import { cleanupProjects, createProject } from './fixture';
import { deferred, KEYS, waitFor } from './helpers';

const terminal = vi.hoisted(() => ({
  options: {} as RenderOptions,
  unmount: undefined as (() => void) | undefined,
}));

vi.mock('ink', async (importOriginal) => {
  const ink = await importOriginal<typeof import('ink')>();
  return {
    ...ink,
    render: ((tree, options) => {
      const instance = ink.render(tree, { ...options, ...terminal.options });
      terminal.unmount = instance.unmount;
      return instance;
    }) as typeof ink.render,
  };
});

const streams: PassThrough[] = [];
afterEach(async () => {
  terminal.unmount?.();
  terminal.unmount = undefined;
  for (const stream of streams.splice(0)) stream.destroy();
  vi.restoreAllMocks();
  await cleanupProjects();
});

function createTerminal() {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  const stdout = Object.assign(new PassThrough(), { columns: 100 });
  const stderr = new PassThrough();
  streams.push(stdin, stdout, stderr);
  let output = '';
  stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  terminal.options = {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  };
  return { stdin, output: () => output };
}

const editor = { async edit() { throw new Error('本测试不使用编辑器'); } };
const open = async () => {};

describe('runReview 真实 Ink 退出码', () => {
  it.each([
    { name: 'q 正常退出', input: 'q', code: 0 },
    { name: 'Esc 从初始视图正常退出', input: KEYS.escape, code: 0 },
    { name: 'Ctrl+C 中断', input: '\u0003', code: 2 },
  ])('$name 返回 $code', async ({ input, code }) => {
    const { artifacts } = await createProject();
    const io = createTerminal();
    const result = runReview({ artifacts, reviewer: '退出码测试', editor, open, view: 'profile' });
    await waitFor(() => io.output().includes('environments.yaml'));
    io.stdin.write(input);
    await expect(result).resolves.toBe(code);
  });

  it.each([
    { name: 'q', input: 'q', code: 0 },
    { name: 'Ctrl+C', input: '\u0003', code: 2 },
  ])('写盘期间 $name 不提前结束 runReview，完成后再次退出返回 $code', async ({ input, code }) => {
    const { artifacts } = await createProject();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const write = artifacts.writeJson.bind(artifacts);
    vi.spyOn(artifacts, 'writeJson').mockImplementation(async (...args) => {
      entered.resolve();
      await gate.promise;
      return write(...args);
    });
    const io = createTerminal();
    let settled = false;
    const result = runReview({ artifacts, reviewer: '退出码测试', editor, open, view: 'profile' });
    void result.then(() => { settled = true; });
    await waitFor(() => io.output().includes('environments.yaml'));
    io.stdin.write('a');
    await entered.promise;
    io.stdin.write(input);
    await waitFor(() => io.output().includes('请等待当前操作完成'));
    expect(settled).toBe(false);
    expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')).toBeUndefined();
    gate.resolve();
    await waitFor(() => io.output().includes('已确认 environments.yaml'));
    expect(settled).toBe(false);
    expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')?.by).toBe('退出码测试');
    io.stdin.write(input);
    await expect(result).resolves.toBe(code);
  });
});
