import { PassThrough } from 'node:stream';
import { Approvals, ArtifactStore } from '@crosscheck/core';
import type { RenderOptions } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReview } from '../src/index';
import { cleanupProjects, clause, createProject, testCase } from './fixture';
import { deferred, KEYS, waitFor } from './helpers';
import { createFailedRun } from './run-fixture';

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

describe('runReview 真实 Ink 退出码（组件模拟流，不代表真实 TTY）', () => {
  it('预取消不打开审核会话或渲染', async () => {
    const { artifacts } = await createProject();
    const io = createTerminal();
    const read = vi.spyOn(artifacts, 'readBytes');
    await expect(runReview({ artifacts, reviewer: '取消测试', editor, open, signal: AbortSignal.abort() })).resolves.toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(io.output()).toBe('');
  });

  it('空闲时外部取消退出 2', async () => {
    const { artifacts } = await createProject();
    const io = createTerminal(); const controller = new AbortController();
    const result = runReview({ artifacts, reviewer: '取消测试', editor, open, view: 'profile', signal: controller.signal });
    await waitFor(() => io.output().includes('environments.yaml'));
    controller.abort();
    await expect(result).resolves.toBe(2);
  });

  it('外部取消等待当前写盘结束，禁止新动作并自动退出 2', async () => {
    const { artifacts } = await createProject();
    const gate = deferred<void>(); const entered = deferred<void>();
    const write = artifacts.writeJson.bind(artifacts);
    vi.spyOn(artifacts, 'writeJson').mockImplementation(async (...args) => { entered.resolve(); await gate.promise; return write(...args); });
    const io = createTerminal(); const controller = new AbortController(); let settled = false;
    const result = runReview({ artifacts, reviewer: '取消测试', editor, open, view: 'profile', signal: controller.signal });
    void result.then(() => { settled = true; });
    await waitFor(() => io.output().includes('environments.yaml'));
    io.stdin.write('a'); await entered.promise;
    controller.abort(); io.stdin.write('r');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    gate.resolve();
    await expect(result).resolves.toBe(2);
    expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')?.by).toBe('取消测试');
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('CLI 接管非 raw %s，等待写盘再返回2且恢复监听器', async (event) => {
    const { cliMain } = await import('../../cli/src/main');
    const { artifacts, root } = await createProject();
    const gate = deferred<void>(); const entered = deferred<void>();
    const write = ArtifactStore.prototype.writeJson;
    vi.spyOn(ArtifactStore.prototype, 'writeJson').mockImplementation(async function (this: ArtifactStore, ...args) {
      entered.resolve(); await gate.promise; return write.apply(this, args);
    });
    const io = createTerminal(); let settled = false;
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const result = cliMain(['review', 'profile', '--project', root], {
      log: () => {}, dependencies: { env: { CROSSCHECK_REVIEWER: '信号测试' }, review: { isTTY: true } },
    });
    void result.then(() => { settled = true; });
    await waitFor(() => io.output().includes('environments.yaml'));
    io.stdin.write('a'); await entered.promise;
    process.emit(event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    gate.resolve();
    await expect(result).resolves.toBe(2);
    expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')?.by).toBe('信号测试');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it.each(['备注', '条款选择', '详情'] as const)('结果%s中的 Ctrl+C 返回 2 且不提交裁决', async (mode) => {
    const { project, runId } = await createFailedRun();
    const io = createTerminal();
    const result = runReview({ artifacts: project.artifacts, reviewer: '退出码测试', editor, open, view: 'results', runId });
    await waitFor(() => io.output().includes('› M-TC-1/E1'));
    io.stdin.write(mode === '备注' ? 'b' : mode === '条款选择' ? 'c' : KEYS.enter);
    await waitFor(() => io.output().includes(mode === '备注' ? '备注' : mode === '条款选择' ? '选择有问题的条款' : '完整详情'));
    io.stdin.write('\u0003');
    await expect(result).resolves.toBe(2);
    expect(await project.artifacts.readBytes(`runs/${runId}/dispositions.json`)).toBeUndefined();
  });

  it.each(['clauses', 'cases'] as const)('%s 完整详情中的 Ctrl+C 保持中断码 2', async (view) => {
    const { artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
    const io = createTerminal();
    const result = runReview({ artifacts, reviewer: '退出码测试', editor, open, view, module: 'M' });
    const id = view === 'clauses' ? 'M-AC-1' : 'M-TC-1';
    await waitFor(() => io.output().includes(`› ${id}`));
    io.stdin.write(KEYS.enter);
    await waitFor(() => io.output().includes(`完整详情 · ${id}`));
    io.stdin.write('\u0003');
    await expect(result).resolves.toBe(2);
  });

  it.each(['clauses', 'cases'] as const)('%s 二次确认中的 Ctrl+C 直接中断，不执行删除或转为普通退出', async (view) => {
    const { artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
    const io = createTerminal();
    const result = runReview({ artifacts, reviewer: '退出码测试', editor, open, view, module: 'M' });
    const id = view === 'clauses' ? 'M-AC-1' : 'M-TC-1';
    await waitFor(() => io.output().includes(`› ${id}`));
    io.stdin.write('d');
    await waitFor(() => io.output().includes(`删除 ${id}？(y/N)`));
    io.stdin.write('\u0003');
    await expect(result).resolves.toBe(2);
    expect(await artifacts.loadClauses('M')).toHaveLength(1);
    expect(await artifacts.loadCases('M')).toHaveLength(1);
    expect(io.output()).not.toContain('已取消');
  });

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
