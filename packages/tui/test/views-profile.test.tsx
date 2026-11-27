import { Approvals, readProfileFile } from '@crosscheck/core';
import { Text, useInput } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, ReviewSession, initialRoute, type EditorHost } from '../src/index';
import { List, clampIndex, moveIndex } from '../src/components';
import { useAction, useEditorPause, useLoader } from '../src/hooks';
import { cleanupProjects, createProject } from './fixture';
import { deferred, KEYS, waitFor } from './helpers';
import { ActionContext, ReviewContext } from '../src/context';
import { ProfileView } from '../src/views/profile';

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await cleanupProjects(); });
const noEditor: EditorHost = { async edit() { throw new Error('请设置 VISUAL 或 EDITOR 环境变量后再编辑'); } };
const open = async () => {};
const frame = (ui: ReturnType<typeof render>) => ui.lastFrame() ?? '';

describe('首页与画像视图', () => {
  it('首页显示四个入口与数量，确认后返回重新加载汇总', async () => {
    const { session, artifacts } = await createProject();
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'home' }} />);
    await waitFor(() => frame(ui).includes('画像审核（待处理 7）'));
    expect(frame(ui)).toContain('条款审核（待处理 0）');
    expect(frame(ui)).toContain('用例审核（待处理 0）');
    expect(frame(ui)).toContain('结果审核（运行 0 次）');
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('未确认'));
    ui.stdin.write('a');
    await waitFor(() => frame(ui).includes('已确认 environments.yaml'));
    expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')?.by).toBe('测试人');
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('画像审核（待处理 6）'));
  });

  it('移动选择后确认、撤销真实落盘，缺少编辑器提示错误且恢复输入', async () => {
    const { session, artifacts } = await createProject();
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'profile' }} />);
    await waitFor(() => frame(ui).includes('environments.yaml'));
    ui.stdin.write(KEYS.down);
    await waitFor(() => frame(ui).includes('› auth.yaml'));
    ui.stdin.write('a');
    await waitFor(() => frame(ui).includes('已确认 auth.yaml'));
    expect((await Approvals.load(artifacts)).record('profile', 'auth.yaml')).toBeDefined();
    expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')).toBeUndefined();
    await waitFor(() => frame(ui).includes('› auth.yaml'));
    ui.stdin.write('r');
    await waitFor(() => frame(ui).includes('已撤销 auth.yaml'));
    expect((await Approvals.load(artifacts)).record('profile', 'auth.yaml')).toBeUndefined();
    await waitFor(() => frame(ui).includes('› auth.yaml'));
    ui.stdin.write('e');
    await waitFor(() => frame(ui).includes('EDITOR') && frame(ui).includes('› auth.yaml'));
    ui.stdin.write('a');
    await waitFor(() => frame(ui).includes('已确认 auth.yaml'));
  });

  it('编辑有效 YAML 后保存原文并使确认失效', async () => {
    const { session, artifacts } = await createProject();
    const editor: EditorHost = { async edit(text) { return `${text.replaceAll('39999', '39998')}\n# 人工审核\n`; } };
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'profile' }} />);
    await waitFor(() => frame(ui).includes('environments.yaml'));
    ui.stdin.write('a');
    await waitFor(() => frame(ui).includes('已确认 environments.yaml') && frame(ui).includes('› environments.yaml'));
    ui.stdin.write('e');
    await waitFor(() => frame(ui).includes('已保存 environments.yaml') && frame(ui).includes('确认已失效'));
    expect((await artifacts.readBytes('system/environments.yaml'))?.toString()).toContain('# 人工审核');
    expect((await artifacts.readBytes('system/environments.yaml'))?.toString()).toContain('39998');
    expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')).toBeDefined();
  });

  it('写操作未完成时拒绝重复操作、返回与退出，完成后才可退出', async () => {
    const { session, artifacts } = await createProject();
    const gate = deferred<void>();
    const write = artifacts.writeJson.bind(artifacts);
    vi.spyOn(artifacts, 'writeJson').mockImplementation(async (...args) => { await gate.promise; return write(...args); });
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'profile' }} />);
    await waitFor(() => frame(ui).includes('environments.yaml'));
    ui.stdin.write('a');
    await waitFor(() => frame(ui).includes('操作进行中'));
    ui.stdin.write('r');
    ui.stdin.write(KEYS.escape);
    ui.stdin.write('q');
    ui.stdin.write('\u0003');
    await waitFor(() => frame(ui).includes('请等待当前操作完成'));
    expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')).toBeUndefined();
    gate.resolve();
    await waitFor(() => frame(ui).includes('已确认 environments.yaml'));
    expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')).toBeDefined();
    ui.stdin.write('q');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const exited = ui.frames.length;
    ui.stdin.write(KEYS.down);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ui.frames.length).toBe(exited);
  });

  it('缺失画像不可确认并显示错误，不写确认记录', async () => {
    const { session, artifacts } = await createProject({ profile: false });
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'profile' }} />);
    await waitFor(() => frame(ui).includes('缺失'));
    ui.stdin.write('a');
    await waitFor(() => frame(ui).includes('不存在'));
    expect((await Approvals.load(artifacts)).record('profile', 'environments.yaml')).toBeUndefined();
  });

  it.each([1, 2, 3])('第 %i 个入口显示模块或运行选择且 Esc 返回首页', async (index) => {
    const { session } = await createProject();
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'home' }} />);
    await waitFor(() => frame(ui).includes('待处理 7'));
    for (let i = 0; i < index; i++) {
      ui.stdin.write(KEYS.down);
      const label = ['条款审核', '用例审核', '结果审核'][i]!;
      await waitFor(() => frame(ui).includes(`› ${label}`));
    }
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes(index === 3 ? '选择运行' : '选择模块'));
    if (index !== 3) expect(frame(ui)).toContain('（空）');
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('画像审核（待处理 7）'));
  });

  it('40×16 已确认画像详情可滚动读完整确认人，不改写记录', async () => {
    const { artifacts, session } = await createProject();
    const file = await readProfileFile(artifacts, 'auth.yaml');
    if (!file.present || !file.ok) throw new Error('画像无效');
    const body = 'reviewer-'.repeat(65);
    const reviewer = `确认人开头\n${body}\\u000a确认人末尾`;
    await session.mutate((approvals) => approvals.approve('profile', 'auth.yaml', file.value, reviewer));
    const before = await artifacts.readBytes('approvals.json');
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'profile', only: ['auth.yaml'] }} />);
    Object.defineProperties(ui.stdout, { columns: { configurable: true, value: 40 }, rows: { configurable: true, value: 16 } });
    ui.stdout.emit('resize');
    await waitFor(() => frame(ui).includes('已确认'));
    expect(frame(ui)).not.toContain('确认人末尾');
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('完整详情 · auth.yaml'));
    const start = '确认人：确认人开头\\u000a';
    const end = '\\\\u000a确认人末尾';
    const visible = () => frame(ui).split('\n');
    expect(visible().join('')).toContain(start);
    // 逐行滚动，拼接每个窗口首次看到的那一行以验证完整名称未被截断。
    const viewport = 11;
    const captured = visible().slice(2, 2 + viewport);
    for (let i = 0; i < 30 && !captured.join('').includes(end); i++) {
      const previous = frame(ui);
      ui.stdin.write(KEYS.down);
      await waitFor(() => frame(ui) !== previous);
      expect(visible().length).toBeLessThanOrEqual(16);
      captured.push(visible()[1 + viewport]!);
    }
    expect(captured.join('')).toContain(`${start}${body}${end}`);
    ui.stdin.write(KEYS.pageDown);
    await waitFor(() => frame(ui).includes('审批载荷'));
    expect(await artifacts.readBytes('approvals.json')).toEqual(before);
  });

  it.each(['guardrails.yaml', 'auth.yaml', 'environments.yaml'] as const)('40×16 长确认人无编辑器可读 %s 完整审批载荷，详情只读且返回仍可确认', async (name) => {
    const { artifacts } = await createProject();
    const session = await ReviewSession.open(artifacts, '很长确认人'.repeat(30));
    const tail = name === 'guardrails.yaml' ? 'host-tail.example:39999' : name === 'auth.yaml' ? 'ACTOR_TAIL' : 'COMMAND_TAIL';
    const value = name === 'guardrails.yaml'
      ? { allowedHosts: [...Array.from({ length: 30 }, (_, i) => `host-${i}.example:39999`), tail] }
      : name === 'auth.yaml'
        ? { version: 1, actors: { ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`guest${i}`, { kind: 'anonymous' }])), last: { kind: 'token', env: tail, inject: { kind: 'header', name: 'Authorization' } } } }
        : { version: 1, environments: { local: { baseURL: 'http://localhost:39999', healthcheck: 'http://localhost:39999/health', reset: null, start: { program: 'node', argv: [...Array.from({ length: 30 }, (_, i) => `argument-${i}`), tail] } } } };
    await artifacts.writeYaml(`system/${name}`, value);
    const before = await artifacts.readBytes(`system/${name}`);
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'profile' }} />);
    Object.defineProperties(ui.stdout, { columns: { configurable: true, value: 40 }, rows: { configurable: true, value: 16 } });
    ui.stdout.emit('resize');
    await waitFor(() => frame(ui).includes('› environments.yaml'));
    const names = ['environments.yaml', 'auth.yaml', 'api-catalog.yaml', 'pages.yaml', 'data-model.yaml', 'fixtures.yaml', 'guardrails.yaml'];
    for (let i = 1; i <= names.indexOf(name); i++) {
      ui.stdin.write(KEYS.down); await waitFor(() => frame(ui).includes(`› ${names[i]}`));
    }
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes(`完整详情 · ${name}`));
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(16);
    let seen = frame(ui);
    for (let i = 0; i < 100 && !seen.includes(tail); i++) {
      const previous = frame(ui); ui.stdin.write(KEYS.down);
      await waitFor(() => frame(ui) !== previous); seen += frame(ui);
    }
    expect(seen).toContain(tail);
    if (name === 'environments.yaml') {
      let found = frame(ui).includes('env: {}');
      for (let i = 0; i < 10 && !found; i++) {
        const previous = frame(ui); ui.stdin.write(KEYS.down);
        await waitFor(() => frame(ui) !== previous); found = frame(ui).includes('env: {}');
      }
      expect(found).toBe(true);
    }
    ui.stdin.write('a'); ui.stdin.write('\u0001');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
    expect(await artifacts.readBytes(`system/${name}`)).toEqual(before);
    ui.stdin.write(KEYS.escape); await waitFor(() => frame(ui).includes(`› ${name}`));
    ui.stdin.write('\u0001'); await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
    ui.stdin.write('a'); await waitFor(() => frame(ui).includes(`已确认 ${name}`));
    expect((await Approvals.load(artifacts)).record('profile', name)?.by).toBe(session.reviewer);
  });

  it('非法 YAML 可安全阅读原文、Esc 返回并编辑修复，不误写审批', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.writeBytes('system/environments.yaml', Buffer.from('broken: [\n终端控制: \u001b[31m原文末尾'));
    const editor: EditorHost = { async edit() { return 'version: 1\nenvironments: {}\n'; } };
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'profile' }} />);
    await waitFor(() => frame(ui).includes('不合法'));
    ui.stdin.write(KEYS.enter); await waitFor(() => frame(ui).includes('完整详情 · environments.yaml'));
    expect(frame(ui)).toContain('broken: ['); expect(frame(ui)).toContain('原文末尾');
    expect(frame(ui)).not.toContain('\u001b');
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
    ui.stdin.write(KEYS.escape); await waitFor(() => frame(ui).includes('› environments.yaml'));
    ui.stdin.write('e'); await waitFor(() => frame(ui).includes('已保存 environments.yaml') && frame(ui).includes('› environments.yaml') && !frame(ui).includes('不合法'));
  });

  it('画像旧行详情在重载读取失败后恢复列表监听，不会因无 row 输入死锁', async () => {
    const { session, artifacts } = await createProject();
    const gate = deferred<void>(); const entered = deferred<void>(); let reloading = false;
    const read = artifacts.readBytes.bind(artifacts);
    vi.spyOn(artifacts, 'readBytes').mockImplementation(async (rel) => {
      if (reloading && rel === 'system/environments.yaml') { entered.resolve(); await gate.promise; throw new Error('画像重载故障'); }
      return read(rel);
    });
    let ui: ReturnType<typeof render>;
    const busy = { current: false };
    const actions = { busy, changed() { if (!busy.current) { reloading = true; ui.stdin.write(KEYS.enter); } } };
    function Probe() {
      const [destination, setDestination] = useState('');
      const nav = { push() {}, back() { setDestination('已返回'); }, quit() { setDestination('已退出'); } };
      return <ReviewContext.Provider value={{ session, editor: noEditor, open }}><ActionContext.Provider value={actions}>
        {destination ? <Text>{destination}</Text> : <ProfileView nav={nav} />}
      </ActionContext.Provider></ReviewContext.Provider>;
    }
    ui = render(<Probe />); await waitFor(() => frame(ui).includes('› environments.yaml'));
    ui.stdin.write('r'); await entered.promise;
    const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = actEnv.IS_REACT_ACT_ENVIRONMENT; actEnv.IS_REACT_ACT_ENVIRONMENT = true;
    try { await act(async () => { gate.resolve(); }); }
    finally { actEnv.IS_REACT_ACT_ENVIRONMENT = previous; }
    await waitFor(() => frame(ui).includes('画像重载故障') && !frame(ui).includes('加载中…'));
    ui.stdin.write(KEYS.escape); await waitFor(() => frame(ui).includes('已返回'));
  });

  it('initialRoute 按视图与参数选择入口', () => {
    expect(initialRoute()).toEqual({ name: 'home' });
    expect(initialRoute('profile')).toEqual({ name: 'profile' });
    expect(initialRoute('clauses')).toEqual({ name: 'modules', kind: 'clauses' });
    expect(initialRoute('clauses', 'M')).toEqual({ name: 'clauses', module: 'M' });
    expect(initialRoute('cases')).toEqual({ name: 'modules', kind: 'cases' });
    expect(initialRoute('cases', 'M')).toEqual({ name: 'cases', module: 'M' });
    expect(initialRoute('results')).toEqual({ name: 'runs' });
    expect(initialRoute('results', undefined, 'r1')).toEqual({ name: 'results', runId: 'r1' });
  });
});

describe('公共组件与异步边界', () => {
  it('列表标题不占选中序号，空列表和越界移动安全', () => {
    const ui = render(<List items={[{ key: 'h', label: '分组', header: true }, { key: 'a', label: '第一项' }, { key: 'b', label: '第二项' }]} index={1} />);
    expect(frame(ui)).toContain('› 第二项');
    expect(moveIndex(0, 2, { upArrow: true, downArrow: false })).toBe(1);
    expect(moveIndex(1, 2, { upArrow: false, downArrow: true })).toBe(0);
    expect(moveIndex(0, 0, { upArrow: true, downArrow: false })).toBe(0);
    expect(clampIndex(5, 2)).toBe(1);
    expect(clampIndex(-2, 0)).toBe(0);
    ui.rerender(<List items={[]} index={0} />);
    return waitFor(() => frame(ui).includes('（空）'));
  });

  it('加载依赖变化时清除旧数据，忽略较早请求并显示同步加载错误', async () => {
    const old = deferred<string>();
    const next = deferred<string>();
    function Probe({ load, id }: { load: () => Promise<string>; id: number }) {
      const { data, error } = useLoader(load, [id]);
      return <Text>{data ?? error ?? '加载中'}</Text>;
    }
    const ui = render(<Probe load={() => old.promise} id={1} />);
    ui.rerender(<Probe load={() => next.promise} id={2} />);
    await waitFor(() => frame(ui).includes('加载中'));
    next.resolve('新结果');
    await waitFor(() => frame(ui).includes('新结果'));
    old.resolve('旧结果');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frame(ui)).toContain('新结果');
    ui.rerender(<Probe load={() => { throw new Error('加载失败'); }} id={3} />);
    await waitFor(() => frame(ui).includes('加载失败'));
    expect(frame(ui)).not.toContain('新结果');
  });

  it('重载失败不保留旧数据，再次重载可恢复', async () => {
    let calls = 0;
    function Probe() {
      const { data, error, reload } = useLoader(async () => {
        calls++;
        if (calls === 2) throw new Error('重载失败');
        return `结果 ${calls}`;
      }, []);
      useInput(() => reload());
      return <Text>{data ?? error ?? '加载中'}</Text>;
    }
    const ui = render(<Probe />);
    await waitFor(() => frame(ui).includes('结果 1'));
    ui.stdin.write('r');
    await waitFor(() => frame(ui).includes('重载失败'));
    expect(frame(ui)).not.toContain('结果 1');
    ui.stdin.write('r');
    await waitFor(() => frame(ui).includes('结果 3'));
  });

  it('卸载后的动作完成不触发旧视图重载或覆盖新视图状态', async () => {
    const pending = deferred<string>();
    let reloads = 0;
    function Probe() {
      const { status, run } = useAction(() => { reloads++; });
      useInput(() => { void run(() => pending.promise); });
      return <Text>{status?.text ?? '就绪'}</Text>;
    }
    const ui = render(<Probe />);
    await waitFor(() => frame(ui).includes('就绪'));
    ui.stdin.write('a');
    await waitFor(() => frame(ui).includes('操作进行中'));
    ui.rerender(<Text>新视图</Text>);
    await waitFor(() => frame(ui).includes('新视图'));
    pending.resolve('旧操作完成');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frame(ui)).toBe('新视图');
    expect(reloads).toBe(0);
  });

  it('编辑暂停保留返回值，异常恢复后可再次调用', async () => {
    function Probe() {
      const pause = useEditorPause();
      const { run, status } = useAction();
      useInput((input) => { void run(() => pause(async () => { if (input === 'e') throw new Error('编辑失败'); return '恢复成功'; })); });
      return <Text>{status?.text ?? '就绪'}</Text>;
    }
    const ui = render(<Probe />);
    await waitFor(() => frame(ui).includes('就绪'));
    ui.stdin.write('e');
    await waitFor(() => frame(ui).includes('编辑失败'));
    ui.stdin.write('a');
    await waitFor(() => frame(ui).includes('恢复成功'));
  });
});
