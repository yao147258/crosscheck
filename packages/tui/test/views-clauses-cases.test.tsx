import { Approvals } from '@crosscheck/core';
import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, ReviewSession, approveClause, type EditorHost } from '../src/index';
import { ActionContext, ReviewContext } from '../src/context';
import { ClausesView } from '../src/views/clauses';
import { CasesView } from '../src/views/cases';
import { List } from '../src/components';
import { cleanupProjects, clause, createProject, testCase } from './fixture';
import { deferred, KEYS, waitFor } from './helpers';

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await cleanupProjects(); });
const editor: EditorHost = { async edit(text) { return text.replace('条款 1', '修改后的条款').replace('检查接口', '检查修改后的接口'); } };
const open = async () => {};
const frame = (ui: ReturnType<typeof render>) => ui.lastFrame() ?? '';
async function waitForAction(ui: ReturnType<typeof render>, text: string, selected: string) {
  await waitFor(() => frame(ui).includes(text));
  // 成功提示可先于 reload 提交，先让 Ink 完成异步重渲染再检查可操作行。
  await new Promise((resolve) => setTimeout(resolve, 30));
  await waitFor(() => frame(ui).includes(text) && frame(ui).includes(`› ${selected}`) && !frame(ui).includes('加载中…'));
}

// 限制真实渲染流尺寸，不替换视图或审批逻辑。
function resize(ui: ReturnType<typeof render>, columns: number, rows: number) {
  Object.defineProperties(ui.stdout, { columns: { configurable: true, value: columns }, rows: { configurable: true, value: rows } });
  ui.stdout.emit('resize');
}

describe('模块列表', () => {
  it.each(['clauses', 'cases'] as const)('%s 合并去重排序两类模块，进入所选模块并返回', async (kind) => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
    await artifacts.saveCases('Z', [testCase(2, ['M-AC-1'], { id: 'Z-TC-2' })]);
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'modules', kind }} />);
    await waitFor(() => frame(ui).includes('› M'));
    expect(frame(ui).match(/› M/g)).toHaveLength(1);
    expect(frame(ui).indexOf('› M')).toBeLessThan(frame(ui).indexOf('  Z'));
    ui.stdin.write(KEYS.down);
    await waitFor(() => frame(ui).includes('› Z'));
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('审核 · Z') && !frame(ui).includes('加载中…') && frame(ui).includes(kind === 'cases' ? 'Z-TC-2' : '（空）'));
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('选择模块'));
  });

  it('空模块和加载错误保持可返回状态', async () => {
    const { session, artifacts } = await createProject();
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'modules', kind: 'clauses' }} />);
    await waitFor(() => frame(ui).includes('（空）'));
    expect(frame(ui)).toContain('Esc 返回');
    ui.unmount();
    vi.spyOn(artifacts, 'listModules').mockRejectedValue(new Error('模块读取失败'));
    const failed = render(<App env={{ session, editor, open }} initial={{ name: 'modules', kind: 'cases' }} />);
    await waitFor(() => frame(failed).includes('模块读取失败'));
    expect(frame(failed)).toContain('q 退出');
  });
});

describe('条款审核', () => {
  it('从模块进入，确认、编辑失效、撤销与 unclear 均更新实际数据', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1, { notes: '审核备注' }), clause(2)]);
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'modules', kind: 'clauses' }} />);
    await waitFor(() => frame(ui).includes('› M'));
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('› M-AC-1'));
    expect(frame(ui)).toContain('来源 需求.md:1');
    expect(frame(ui)).toContain('摘录 原文 1');
    expect(frame(ui)).toContain('备注 审核备注');
    ui.stdin.write('a');
    await waitForAction(ui, '已确认 M-AC-1', 'M-AC-1');
    expect((await Approvals.load(artifacts)).record('clause', 'M-AC-1')?.by).toBe('测试人');
    ui.stdin.write('e');
    await waitForAction(ui, '已保存 M-AC-1', 'M-AC-1');
    expect(frame(ui)).toContain('确认已失效');
    expect((await artifacts.loadClauses('M'))[0]?.text).toBe('修改后的条款');
    ui.stdin.write('r');
    await waitForAction(ui, '已撤销 M-AC-1', 'M-AC-1');
    expect((await Approvals.load(artifacts)).record('clause', 'M-AC-1')).toBeUndefined();
    ui.stdin.write(KEYS.down);
    await waitFor(() => frame(ui).includes('› M-AC-2'));
    expect(frame(ui)).toContain('来源 需求.md:2');
    ui.stdin.write('u');
    await waitForAction(ui, 'M-AC-2 已标记为 unclear', 'M-AC-2');
    expect(frame(ui)).toContain('[unclear]');
    expect((await artifacts.loadClauses('M'))[1]?.status).toBe('unclear');
    ui.stdin.write('a');
    await waitFor(() => frame(ui).includes('只有 active 条款可以确认'));
    expect((await Approvals.load(artifacts)).record('clause', 'M-AC-2')).toBeUndefined();
  });

  it('取消删除不落盘且消费导航键，批量只确认 active，删除后夹紧选中项', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2, { status: 'unclear' }), clause(3)]);
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'clauses', module: 'M' }} />);
    await waitFor(() => frame(ui).includes('› M-AC-1'));
    ui.stdin.write('d');
    await waitFor(() => frame(ui).includes('删除 M-AC-1？(y/N)'));
    ui.stdin.write(KEYS.down);
    await waitFor(() => frame(ui).includes('已取消'));
    expect(frame(ui)).toContain('› M-AC-1');
    expect(await artifacts.loadClauses('M')).toHaveLength(3);
    ui.stdin.write('A');
    await waitFor(() => frame(ui).includes('active') && frame(ui).includes('(y/N)'));
    expect((await Approvals.load(artifacts)).record('clause', 'M-AC-1')).toBeUndefined();
    ui.stdin.write('y');
    await waitForAction(ui, '已确认 2 条条款', 'M-AC-1');
    expect((await Approvals.load(artifacts)).record('clause', 'M-AC-2')).toBeUndefined();
    ui.stdin.write(KEYS.up);
    await waitFor(() => frame(ui).includes('› M-AC-3'));
    ui.stdin.write('d');
    await waitFor(() => frame(ui).includes('删除 M-AC-3？(y/N)'));
    ui.stdin.write('y');
    await waitFor(() => frame(ui).includes('已删除 M-AC-3') && frame(ui).includes('› M-AC-2'));
    expect((await artifacts.loadClauses('M')).map((c) => c.id)).toEqual(['M-AC-1', 'M-AC-2']);
    expect((await Approvals.load(artifacts)).record('clause', 'M-AC-3')).toBeUndefined();
  });
});

describe('用例审核', () => {
  it('按首个覆盖条款分组，确认与撤销实时更新覆盖率，详情展示角色夹具步骤预期证据', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2)]);
    await artifacts.saveCases('M', [testCase(2, ['M-AC-2']), testCase(1, ['M-AC-1'], { fixtures: ['种子数据'] })]);
    await approveClause(session, 'M', 'M-AC-1');
    await approveClause(session, 'M', 'M-AC-2');
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'cases', module: 'M' }} />);
    await waitFor(() => frame(ui).includes('覆盖率 0/2'));
    expect(frame(ui)).toContain('未覆盖：M-AC-1, M-AC-2');
    expect(frame(ui)).toContain('▸ M-AC-1');
    expect(frame(ui)).toContain('› M-TC-1');
    expect(frame(ui)).toContain('角色 guest · 夹具 种子数据');
    expect(frame(ui)).toContain('1. 检查接口');
    expect(frame(ui)).toContain('E1 值为 ok [network]');
    ui.stdin.write('a');
    await waitForAction(ui, '已确认 M-TC-1', 'M-TC-1');
    expect(frame(ui)).toContain('覆盖率 1/2');
    expect(frame(ui)).toContain('未覆盖：M-AC-2');
    expect((await Approvals.load(artifacts)).record('case', 'M-TC-1')?.by).toBe('测试人');
    ui.stdin.write('r');
    await waitForAction(ui, '已撤销 M-TC-1', 'M-TC-1');
    expect(frame(ui)).toContain('覆盖率 0/2');
    expect((await Approvals.load(artifacts)).record('case', 'M-TC-1')).toBeUndefined();
    ui.stdin.write(KEYS.down);
    await waitFor(() => frame(ui).includes('› M-TC-2'));
    ui.stdin.write('a');
    await waitFor(() => frame(ui).includes('覆盖率 1/2') && frame(ui).includes('› M-TC-2'));
    expect((await Approvals.load(artifacts)).record('case', 'M-TC-2')).toBeDefined();
  });

  it('未确认条款归入其他组且禁止确认，批量跳过不可确认用例，编辑使覆盖失效', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1']), testCase(2, ['M-AC-2'])]);
    await approveClause(session, 'M', 'M-AC-1');
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'cases', module: 'M' }} />);
    await waitFor(() => frame(ui).includes('› M-TC-1'));
    expect(frame(ui)).toContain('其他（第一个覆盖条款未确认）');
    ui.stdin.write(KEYS.down);
    await waitFor(() => frame(ui).includes('› M-TC-2'));
    ui.stdin.write('a');
    await waitForAction(ui, '覆盖的条款尚未确认', 'M-TC-2');
    expect((await Approvals.load(artifacts)).record('case', 'M-TC-2')).toBeUndefined();
    ui.stdin.write('A');
    await waitFor(() => frame(ui).includes('可确认的用例？(y/N)'));
    ui.stdin.write('n');
    await waitFor(() => frame(ui).includes('已取消'));
    expect((await Approvals.load(artifacts)).record('case', 'M-TC-1')).toBeUndefined();
    ui.stdin.write('A');
    await waitFor(() => frame(ui).includes('可确认的用例？(y/N)'));
    ui.stdin.write('y');
    await waitForAction(ui, '已确认 1 个用例，跳过 1 个', 'M-TC-2');
    expect(frame(ui)).toContain('覆盖率 1/1');
    ui.stdin.write(KEYS.up);
    await waitFor(() => frame(ui).includes('› M-TC-1'));
    ui.stdin.write('e');
    await waitForAction(ui, '已保存 M-TC-1', 'M-TC-1');
    expect(frame(ui)).toContain('确认已失效');
    expect(frame(ui)).toContain('覆盖率 0/1');
    expect((await artifacts.loadCases('M'))[0]?.steps).toEqual(['检查修改后的接口']);
    ui.stdin.write('d');
    await waitFor(() => frame(ui).includes('删除 M-TC-1？(y/N)'));
    ui.stdin.write('q');
    await waitFor(() => frame(ui).includes('已取消'));
    expect(await artifacts.loadCases('M')).toHaveLength(2);
    ui.stdin.write('d');
    await waitFor(() => frame(ui).includes('删除 M-TC-1？(y/N)'));
    ui.stdin.write('y');
    await waitFor(() => frame(ui).includes('已删除 M-TC-1') && frame(ui).includes('› M-TC-2'));
    expect((await artifacts.loadCases('M')).map((c) => c.id)).toEqual(['M-TC-2']);
    expect((await Approvals.load(artifacts)).record('case', 'M-TC-1')).toBeUndefined();
  });
});

describe('审核边界与终端可用性', () => {
  const noEditor: EditorHost = { async edit() { throw new Error('未设置 EDITOR'); } };
  const pageDown = '\u001B[6~';
  const pageUp = '\u001B[5~';
  async function scrollUntil(ui: ReturnType<typeof render>, target: string, key = KEYS.down) {
    let seen = frame(ui);
    for (let i = 0; i < 120 && !seen.replaceAll('\n', '').includes(target); i++) {
      const before = frame(ui);
      ui.stdin.write(key);
      await waitFor(() => frame(ui) !== before);
      expect(frame(ui).split('\n').length).toBeLessThanOrEqual(16);
      seen += `\n${frame(ui)}`;
    }
    expect(seen.replaceAll('\n', '')).toContain(target);
    return seen;
  }

  it.each([
    { name: 'clauses', outcome: 'empty' }, { name: 'clauses', outcome: 'error' },
    { name: 'cases', outcome: 'empty' }, { name: 'cases', outcome: 'error' },
  ] as const)('$name 动作释放后 Enter 打开旧行，延迟重载得到 $outcome 时仍能返回或退出', async ({ name, outcome }) => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
    const gate = deferred<void>();
    const entered = deferred<void>();
    let reloading = false;
    const delayed = <T,>(load: (module: string) => Promise<T[]>) => async (module: string): Promise<T[]> => {
      if (!reloading) return load(module);
      entered.resolve();
      await gate.promise;
      if (outcome === 'error') throw new Error('延迟重载失败');
      return [];
    };
    const loadClauses = artifacts.loadClauses.bind(artifacts);
    const loadCases = artifacts.loadCases.bind(artifacts);
    if (name === 'clauses') vi.spyOn(artifacts, 'loadClauses').mockImplementation(delayed(loadClauses));
    else vi.spyOn(artifacts, 'loadCases').mockImplementation(delayed(loadCases));
    let ui: ReturnType<typeof render>;
    const busy = { current: false };
    const actions = { busy, changed() {
      if (!busy.current) {
        reloading = true;
        // 在真实 useAction 释放锁、调用 reload 前同步发送 Enter，固定复现竞态。
        ui.stdin.write(KEYS.enter);
      }
    } };
    function Probe() {
      const [destination, setDestination] = useState('');
      const nav = { push() {}, back() { setDestination('已返回'); }, quit() { setDestination('已退出'); } };
      return <ReviewContext.Provider value={{ session, editor: noEditor, open }}><ActionContext.Provider value={actions}>
        {destination ? <Text>{destination}</Text> : name === 'clauses' ? <ClausesView nav={nav} module="M" /> : <CasesView nav={nav} module="M" />}
      </ActionContext.Provider></ReviewContext.Provider>;
    }
    ui = render(<Probe />);
    await waitFor(() => frame(ui).includes(name === 'clauses' ? '› M-AC-1' : '› M-TC-1'));
    ui.stdin.write('r');
    await entered.promise;
    // 帧输出不代表输入订阅已交接；仅在本次 act 内启用环境标志并恢复原值。
    const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT;
    actEnv.IS_REACT_ACT_ENVIRONMENT = true;
    try { await act(async () => { gate.resolve(); }); }
    finally { actEnv.IS_REACT_ACT_ENVIRONMENT = previousActEnv; }
    await waitFor(() => frame(ui).includes(outcome === 'empty' ? '（空）' : '延迟重载失败') && !frame(ui).includes('加载中…'));
    ui.stdin.write(outcome === 'empty' ? KEYS.escape : 'q');
    await waitFor(() => frame(ui).includes(outcome === 'empty' ? '已返回' : '已退出'));
  });

  it.each(['clauses', 'cases'] as const)('%s 长确认人在 40×16 完整详情不挤出正文和页脚，滚动返回仍可操作', async (name) => {
    const { artifacts } = await createProject();
    const session = await ReviewSession.open(artifacts, '一二三四五六七八');
    await artifacts.saveClauses('M', [clause(1, { text: `正文开头\n${'很长正文'.repeat(100)}\n正文末尾` })]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'], { steps: [`步骤开头\n${'很长步骤'.repeat(100)}\n步骤末尾`] })]);
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name, module: 'M' }} />);
    resize(ui, 40, 16);
    const id = name === 'clauses' ? 'M-AC-1' : 'M-TC-1';
    await waitFor(() => frame(ui).includes(`› ${id}`));
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes(`完整详情 · ${id}`));
    expect(frame(ui)).toContain('PageUp/PageDown');
    expect(frame(ui)).toContain('Esc 返回列表');
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(16);
    await scrollUntil(ui, name === 'clauses' ? '正文末尾' : '步骤末尾', pageDown);
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes(`› ${id}`));
  });

  it('40×16 无 EDITOR 的单用例可 Enter 读取基本预期与证据，Esc 返回原选中项', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await approveClause(session, 'M', 'M-AC-1');
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'cases', module: 'M' }} />);
    resize(ui, 40, 16);
    await waitFor(() => frame(ui).includes('› M-TC-1'));
    expect(frame(ui)).toContain('Enter 详情');
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('完整详情 · M-TC-1'));
    await scrollUntil(ui, 'E1 值为 ok');
    await scrollUntil(ui, 'network');
    ui.stdin.write('a');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await Approvals.load(artifacts)).record('case', 'M-TC-1')).toBeUndefined();
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('› M-TC-1'));
    ui.stdin.write('a');
    await waitForAction(ui, '已确认 M-TC-1', 'M-TC-1');
  });

  it('40×16 无 EDITOR 可滚动长多行预期和末尾全部证据，PageUp 返回开头，返回列表保留第二项', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await approveClause(session, 'M', 'M-AC-1');
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1']), testCase(2, ['M-AC-1'], {
      steps: ['检查开始', '检查结束'],
      expectations: [{ id: 'E1', text: `预期开头\n${'中间内容'.repeat(80)}\n预期末尾`, evidence: ['screenshot', 'dom', 'network', 'console', 'db'] }, { id: 'E2', text: '最后一项预期', evidence: ['db'] }],
    })]);
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'cases', module: 'M' }} />);
    resize(ui, 40, 16);
    await waitFor(() => frame(ui).includes('› M-TC-1'));
    ui.stdin.write(KEYS.down);
    await waitFor(() => frame(ui).includes('› M-TC-2'));
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('完整详情 · M-TC-2'));
    await scrollUntil(ui, '预期开头');
    const seen = await scrollUntil(ui, '最后一项预期', pageDown);
    const joined = seen.replaceAll('\n', '');
    expect(joined).toContain('预期末尾');
    for (const evidence of ['screenshot', 'dom', 'network', 'console', 'db']) expect(joined).toContain(evidence);
    await scrollUntil(ui, '角色 guest', pageUp);
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('› M-TC-2'));
    ui.stdin.write('d');
    await waitFor(() => frame(ui).includes('删除 M-TC-2？(y/N)'));
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('已取消'));
    expect(frame(ui)).not.toContain('完整详情');
    expect(await artifacts.loadCases('M')).toHaveLength(2);
  });

  it('40×16 无 EDITOR 可读完整条款正文、长来源、摘录备注，滚动不改变列表选择', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2, {
      text: `正文开头\n${'长正文'.repeat(80)}\n正文末尾`,
      source: { file: `${'需求目录/'.repeat(20)}来源末尾.md`, line: 27, excerpt: `摘录开头\n${'摘录内容'.repeat(40)}\n摘录末尾` },
      notes: '完整备注末尾',
    })]);
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'clauses', module: 'M' }} />);
    resize(ui, 40, 16);
    await waitFor(() => frame(ui).includes('› M-AC-1'));
    expect(frame(ui)).toContain('Enter 详情');
    ui.stdin.write(KEYS.down);
    await waitFor(() => frame(ui).includes('› M-AC-2'));
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('完整详情 · M-AC-2'));
    await scrollUntil(ui, '正文末尾');
    await scrollUntil(ui, '来源末尾.md:27');
    await scrollUntil(ui, '摘录末尾');
    await scrollUntil(ui, '完整备注末尾');
    const before = frame(ui);
    ui.stdin.write(KEYS.up);
    await waitFor(() => frame(ui) !== before);
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('› M-AC-2'));
    expect((await Approvals.load(artifacts)).record('clause', 'M-AC-2')).toBeUndefined();
  });

  it.each(['clauses', 'cases'] as const)('%s 空态与加载失败不允许行操作', async (name) => {
    const { session, artifacts } = await createProject();
    const ui = render(<App env={{ session, editor, open }} initial={{ name, module: 'M' }} />);
    await waitFor(() => frame(ui).includes('（空）'));
    ui.stdin.write('d');
    ui.stdin.write('a');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frame(ui)).not.toContain('(y/N)');
    ui.unmount();
    vi.spyOn(artifacts, 'loadClauses').mockRejectedValue(new Error('条款读取失败'));
    const failed = render(<App env={{ session, editor, open }} initial={{ name, module: 'M' }} />);
    await waitFor(() => frame(failed).includes('条款读取失败'));
    expect(frame(failed)).toContain('q 退出');
  });

  it.each(['clauses', 'cases'] as const)('%s 写盘期间拒绝重复操作和退出，完成后不误删旧选中项', async (name) => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2)]);
    await approveClause(session, 'M', 'M-AC-1');
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1']), testCase(2, ['M-AC-1'])]);
    const gate = deferred<void>();
    const entered = deferred<void>();
    const write = artifacts.writeJson.bind(artifacts);
    vi.spyOn(artifacts, 'writeJson').mockImplementation(async (...args) => { entered.resolve(); await gate.promise; return write(...args); });
    const ui = render(<App env={{ session, editor, open }} initial={{ name, module: 'M' }} />);
    const id = name === 'clauses' ? 'M-AC-1' : 'M-TC-1';
    await waitFor(() => frame(ui).includes(`› ${id}`));
    ui.stdin.write('a');
    await entered.promise;
    ui.stdin.write(KEYS.enter);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frame(ui)).not.toContain('完整详情');
    ui.stdin.write('r');
    ui.stdin.write(KEYS.escape);
    ui.stdin.write('q');
    await waitFor(() => frame(ui).includes('请等待当前操作完成'));
    gate.resolve();
    await waitForAction(ui, `已确认 ${id}`, id);
    expect((await Approvals.load(artifacts)).record(name === 'clauses' ? 'clause' : 'case', id)).toBeDefined();
    ui.stdin.write('d');
    await waitFor(() => frame(ui).includes(`删除 ${id}？(y/N)`));
    ui.stdin.write('y');
    await waitFor(() => frame(ui).includes(`已删除 ${id}`) && !frame(ui).includes(`› ${id}`));
    expect(await (name === 'clauses' ? artifacts.loadClauses('M') : artifacts.loadCases('M'))).toHaveLength(1);
  });

  it('公共列表窗口保留分组上下文与可见选中项，不渲染整张长列表', async () => {
    const items = Array.from({ length: 40 }, (_, i) => [{ key: `h${i}`, label: `分组 ${i}`, header: true }, { key: `r${i}`, label: `条目 ${i} ${'长'.repeat(80)}` }]).flat();
    const ui = render(<List items={items} index={39} />);
    resize(ui, 40, 16);
    await waitFor(() => frame(ui).includes('› 条目 39'));
    expect(frame(ui)).toContain('分组 39');
    expect(frame(ui)).not.toContain('条目 0');
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(8);
  });

  it.each(['clauses', 'cases'] as const)('%s 窄终端的长编辑错误不挤掉选中行与操作提示，恢复后仍可操作', async (name) => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
    const failingEditor: EditorHost = { async edit() { throw new Error(`编辑失败：${'详细诊断'.repeat(100)}`); } };
    const ui = render(<App env={{ session, editor: failingEditor, open }} initial={{ name, module: 'M' }} />);
    resize(ui, 40, 16);
    const id = name === 'clauses' ? 'M-AC-1' : 'M-TC-1';
    await waitFor(() => frame(ui).includes(`› ${id}`));
    ui.stdin.write('e');
    await waitForAction(ui, '编辑失败', id);
    expect(frame(ui)).toContain('a/r/e');
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(16);
    ui.stdin.write('d');
    await waitFor(() => frame(ui).includes(`删除 ${id}？(y/N)`));
  });

  it.each(['clauses', 'cases'] as const)('%s 长列表在 40×16 终端保留选中行、确认提示与操作状态', async (name) => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', Array.from({ length: 40 }, (_, i) => clause(i + 1, { text: '很长的条款正文'.repeat(80) })));
    await approveClause(session, 'M', 'M-AC-1');
    await artifacts.saveCases('M', Array.from({ length: 40 }, (_, i) => testCase(i + 1, ['M-AC-1'], { steps: Array(40).fill('很长的步骤'.repeat(40)) })));
    const ui = render(<App env={{ session, editor, open }} initial={{ name, module: 'M' }} />);
    resize(ui, 40, 16);
    const prefix = name === 'clauses' ? 'M-AC' : 'M-TC';
    await waitFor(() => frame(ui).includes(`› ${prefix}-1`));
    ui.stdin.write(KEYS.up);
    await waitFor(() => frame(ui).includes(`› ${prefix}-40`));
    expect(frame(ui)).toContain('a/r/e');
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(16);
    ui.stdin.write('d');
    await waitFor(() => frame(ui).includes(`删除 ${prefix}-40？(y/N)`));
    expect(frame(ui)).toContain(`› ${prefix}-40`);
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(16);
    ui.stdin.write('n');
    await waitFor(() => frame(ui).includes('已取消'));
    expect(frame(ui)).toContain(`› ${prefix}-40`);
  });
});
