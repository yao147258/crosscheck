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

  it('真实 CLI 确认写盘失败并发外部取消保留宿主错误退出3', async () => {
    const { cliMain } = await import('../../cli/src/main');
    const { artifacts, root, userHome } = await createProject();
    const gate = deferred<void>(); const entered = deferred<void>();
    const controller = new AbortController(); const logs: string[] = [];
    const write = ArtifactStore.prototype.writeJson;
    vi.spyOn(ArtifactStore.prototype, 'writeJson').mockImplementation(async function (this: ArtifactStore, ...args) {
      if (args[0] === 'approvals.json') { entered.resolve(); await gate.promise; throw new Error('确认记录磁盘故障 fixture-key', { cause: new Error('fixture-key') }); }
      return write.apply(this, args);
    });
    const io = createTerminal();
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const result = cliMain(['review', 'profile', '--project', root], {
      signal: controller.signal, log: (s) => logs.push(s),
      dependencies: { userConfigHome: userHome, env: { CROSSCHECK_REVIEWER: '故障测试' }, review: { isTTY: true } },
    });
    await waitFor(() => io.output().includes('environments.yaml'));
    io.stdin.write('a'); await entered.promise;
    controller.abort(); gate.resolve();
    await expect(result).resolves.toBe(3);
    expect(logs.join('')).toContain('确认记录磁盘故障 [REDACTED]');
    expect(logs.join('')).not.toContain('fixture-key');
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it.each((['signal', 'raw'] as const).flatMap((interrupt) => [
    { boundary: 'summary', fail: false, interrupt }, { boundary: 'summary', fail: true, interrupt },
    { boundary: 'evidence', fail: false, interrupt }, { boundary: 'evidence', fail: true, interrupt },
  ] as const))('结果加载 $boundary（失败=$fail，取消=$interrupt）等待真实锁释放再返回，错误优先3', async ({ boundary, fail, interrupt }) => {
    const { cliMain } = await import('../../cli/src/main');
    const { project, runId } = await createFailedRun();
    const gate = deferred<void>(); const entered = deferred<void>();
    const controller = new AbortController(); let settled = false;
    const logs: string[] = [];
    if (boundary === 'summary') {
      const { RunStore } = await import('@crosscheck/runner');
      const read = RunStore.prototype.readSummary;
      vi.spyOn(RunStore.prototype, 'readSummary').mockImplementation(async function (this: import('@crosscheck/runner').RunStore) {
        entered.resolve(); await gate.promise;
        if (fail) throw new Error('运行汇总读取故障');
        return read.call(this);
      });
    } else {
      const read = ArtifactStore.prototype.readBytes;
      vi.spyOn(ArtifactStore.prototype, 'readBytes').mockImplementation(async function (this: ArtifactStore, rel) {
        if (rel.includes('/evidence/files/')) {
          entered.resolve(); await gate.promise;
          if (fail) throw new Error('证据读取故障');
        }
        return read.call(this, rel);
      });
    }
    const io = createTerminal();
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const result = cliMain(['review', 'results', '--run', runId, '--project', project.root], {
      signal: controller.signal, log: (s) => logs.push(s),
      dependencies: { env: { CROSSCHECK_REVIEWER: '加载取消测试' }, review: { isTTY: true } },
    });
    void result.then(() => { settled = true; });
    await entered.promise;
    expect(await project.artifacts.readBytes(`runs/${runId}/lock.json`)).toBeDefined();
    if (interrupt === 'raw') io.stdin.write('\u0003');
    else controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    io.stdin.write('b');
    const returnedBeforeRelease = settled;
    gate.resolve();
    const code = await result;
    await waitFor(() => settled);
    expect(returnedBeforeRelease).toBe(false);
    expect(code).toBe(fail ? 3 : 2);
    if (fail) expect(logs.join('')).toContain(boundary === 'summary' ? '运行汇总读取故障' : '证据读取故障');
    expect(await project.artifacts.readBytes(`runs/${runId}/lock.json`)).toBeUndefined();
    expect(await project.artifacts.readBytes(`runs/${runId}/dispositions.json`)).toBeUndefined();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it('画像 raw Ctrl+A/R/E/Q 不确认、不撤销、不编辑或退出，普通 a/r/e 保持且 Ctrl+C 返回2', async () => {
    const { artifacts } = await createProject();
    const io = createTerminal(); let edits = 0; let settled = false;
    const result = runReview({ artifacts, reviewer: '快捷键测试', open, view: 'profile', editor: {
      async edit(text) { edits++; return `${text}\n# 普通编辑\n`; },
    } });
    void result.then(() => { settled = true; });
    await waitFor(() => io.output().includes('environments.yaml'));
    const before = await artifacts.readBytes('system/environments.yaml');
    io.stdin.write('\u0001');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
    io.stdin.write('a');
    await waitFor(() => io.output().includes('已确认 environments.yaml'));
    const approved = await artifacts.readBytes('approvals.json');
    for (const key of ['\u0012', '\u0005', '\u0011']) {
      // 每次单独经过真实 readable 回合，避免多个控制字节被 Ink 合并为一次输入。
      io.stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await artifacts.readBytes('approvals.json')).toEqual(approved);
      expect(await artifacts.readBytes('system/environments.yaml')).toEqual(before);
      expect(edits).toBe(0); expect(settled).toBe(false);
    }
    io.stdin.write('r'); await waitFor(() => io.output().includes('已撤销 environments.yaml'));
    expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')).toBeUndefined();
    // 成功提示早于 useLoader 的新帧，只在最新完整帧恢复选中行后发送编辑键。
    await waitFor(() => io.output().slice(io.output().lastIndexOf('画像审核')).includes('› environments.yaml'));
    io.stdin.write('e'); await waitFor(() => io.output().includes('已保存 environments.yaml'));
    expect(edits).toBe(1);
    io.stdin.write('\u0003'); await expect(result).resolves.toBe(2);
  });

  it('编辑暂停使用注入的 TTY 输入，等待 pause 的 nextTick 后交接，出错后仍能取消退出', async () => {
    const { artifacts } = await createProject();
    const io = createTerminal();
    terminal.options.interactive = true;
    let paused = false; let stopped = false; let calls = 0;
    const pause = io.stdin.pause.bind(io.stdin);
    vi.spyOn(io.stdin, 'pause').mockImplementation(() => {
      paused = true;
      process.nextTick(() => { stopped = true; });
      return pause();
    });
    const observations: boolean[] = [];
    const controller = new AbortController();
    const result = runReview({ artifacts, reviewer: '编辑交接测试', open, view: 'profile', signal: controller.signal, editor: {
      async edit(text) {
        observations.push(paused && stopped);
        paused = false; stopped = false;
        if (++calls === 1) throw new Error('编辑器受控失败');
        return `${text}\n# 重复编辑已恢复\n`;
      },
    } });
    await waitFor(() => io.output().includes('environments.yaml'));
    io.stdin.write('e');
    await waitFor(() => io.output().includes('编辑器受控失败'));
    expect(observations).toEqual([true]);
    controller.abort(); await expect(result).resolves.toBe(2);
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
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

  it('画像完整详情 raw Ctrl+C 返回2且不写审批', async () => {
    const { artifacts } = await createProject(); const io = createTerminal();
    const result = runReview({ artifacts, reviewer: '详情取消', editor, open, view: 'profile' });
    await waitFor(() => io.output().includes('› environments.yaml'));
    io.stdin.write(KEYS.enter); await waitFor(() => io.output().includes('完整详情 · environments.yaml'));
    io.stdin.write('\u0003'); await expect(result).resolves.toBe(2);
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
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
