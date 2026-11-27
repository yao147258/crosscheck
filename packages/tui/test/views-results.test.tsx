import { readFile } from 'node:fs/promises';
import { Approvals, DispositionsFileSchema } from '@crosscheck/core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, loadResultRows, type EditorHost } from '../src/index';
import * as results from '../src/state/results';
import { cleanupProjects, createProject } from './fixture';
import { deferred, KEYS, waitFor } from './helpers';
import { createFailedRun } from './run-fixture';

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await cleanupProjects(); });
const editor: EditorHost = { async edit() { throw new Error('未设置 EDITOR'); } };
const open = async () => {};
const frame = (ui: ReturnType<typeof render>) => ui.lastFrame() ?? '';
function resize(ui: ReturnType<typeof render>, columns: number, rows: number) {
  Object.defineProperties(ui.stdout, { columns: { configurable: true, value: columns }, rows: { configurable: true, value: rows } });
  ui.stdout.emit('resize');
}
async function ready(ui: ReturnType<typeof render>, text = '› M-TC-1/E1 FAIL') {
  await waitFor(() => frame(ui).includes(text) && !frame(ui).includes('加载中…'));
}
async function scrollTo(ui: ReturnType<typeof render>, target: string) {
  let seen = frame(ui);
  for (let i = 0; i < 150 && !seen.replaceAll('\n', '').includes(target); i++) {
    const before = frame(ui);
    ui.stdin.write(KEYS.down);
    try { await waitFor(() => frame(ui) !== before); }
    catch { throw new Error(`无法继续滚动到 ${target}；当前帧 ${frame(ui)}；已读取 ${seen}`); }
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(16);
    seen += frame(ui);
  }
  expect(seen.replaceAll('\n', '')).toContain(target);
}

describe('运行列表与结果审核', () => {
  it('真实运行进入结果，双方判定、预期与证据可读，Tab 切换后导出原字节并请求打开', async () => {
    const { project, runId } = await createFailedRun();
    const opened: string[] = [];
    const ui = render(<App env={{ session: project.session, editor, open: async (file) => { opened.push(file); } }} initial={{ name: 'runs' }} />);
    resize(ui, 140, 40);
    await waitFor(() => frame(ui).includes(runId));
    ui.stdin.write(KEYS.enter);
    await ready(ui);
    expect(frame(ui)).toContain('M-TC-1/E2 DISPUTED');
    expect(frame(ui)).not.toContain('M-TC-1/E3');
    expect(frame(ui)).toContain('值为 ok');
    expect(frame(ui)).toContain('执行方理由');
    expect(frame(ui)).toContain('复核方理由');
    const lines = frame(ui).split('\n');
    expect(lines.some((line) => line.includes('执行方') && line.includes('复核方'))).toBe(true);
    const [row] = await loadResultRows(project.session, runId);
    const selected = row!.evidence[1 % row!.evidence.length]!;
    ui.stdin.write(KEYS.tab);
    ui.stdin.write('o');
    await waitFor(() => frame(ui).includes('已请求打开'));
    expect(opened).toEqual([project.artifacts.resolve(`.open/${selected.id}.txt`)]);
    expect(await readFile(opened[0]!)).toEqual(await project.artifacts.readBytes(selected.path));
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('选择运行'));
  });

  it('结果详情可见转义历史裁决确认人，不让换行切断确认人行', async () => {
    const { project, runId } = await createFailedRun();
    await project.artifacts.writeJson(`runs/${runId}/dispositions.json`, { version: 1, runId, items: [{
      caseId: 'M-TC-1', expectationId: 'E1', decision: 'false_positive', note: '', by: '历史\n人\x1b', at: '2026-11-16T00:00:00.000Z',
    }] });
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    resize(ui, 140, 60);
    await ready(ui);
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('完整详情 · M-TC-1/E1'));
    expect(frame(ui)).toContain('确认人：历史\\u000a人\\u001b');
  });

  it('运行列表倒序、窗口化、空态和加载错误可返回', async () => {
    const { session, artifacts } = await createProject();
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'runs' }} />);
    await waitFor(() => frame(ui).includes('暂无运行'));
    ui.unmount();
    const ids = Array.from({ length: 30 }, (_, i) => `20261116T000000${String(i).padStart(3, '0')}Z-${'a'.repeat(32)}`);
    for (const id of ids) await artifacts.writeJson(`runs/${id}/manifest.json`, {});
    const many = render(<App env={{ session, editor, open }} initial={{ name: 'runs' }} />);
    resize(many, 40, 16);
    await waitFor(() => frame(many).includes('› 20261116T000000029Z'));
    expect(frame(many)).not.toContain('20261116T000000000Z');
    expect(frame(many).split('\n').length).toBeLessThanOrEqual(16);
    many.stdin.write(KEYS.up);
    await waitFor(() => frame(many).includes('› 20261116T000000000Z'));
    many.unmount();
    vi.spyOn(artifacts, 'list').mockRejectedValue(new Error('运行目录读取失败'));
    const failed = render(<App env={{ session, editor, open }} initial={{ name: 'runs' }} />);
    await waitFor(() => frame(failed).includes('运行目录读取失败'));
    expect(frame(failed)).toContain('Esc 返回');
  });

  it('运行列表连续移动后 Enter 进入最新选择的运行而不是旧闭包行', async () => {
    const { session, artifacts } = await createProject();
    const older = `20261115T000000000Z-${'a'.repeat(32)}`;
    const newer = `20261116T000000000Z-${'b'.repeat(32)}`;
    for (const id of [older, newer]) await artifacts.writeJson(`runs/${id}/manifest.json`, {});
    vi.spyOn(results, 'loadResultRows').mockResolvedValue([]);
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'runs' }} />);
    resize(ui, 140, 40);
    await waitFor(() => frame(ui).includes(`› ${newer}`));
    ui.stdin.write(KEYS.down);
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('没有 FAIL 或 DISPUTED'));
    expect(frame(ui)).toContain(`结果审核 · ${older}`);
    expect(frame(ui)).not.toContain(newer);
  });

  it('运行列表连续 Enter 只进入一次，Esc 直接返回运行列表', async () => {
    const { project, runId } = await createFailedRun();
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'runs' }} />);
    await waitFor(() => frame(ui).includes(runId));
    ui.stdin.write(KEYS.enter);
    ui.stdin.write(KEYS.enter);
    await ready(ui);
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('选择运行'));
  });

  it('Enter 后连续裁决按键不得穿透详情，也不改变返回后的选中行', async () => {
    const { project, runId } = await createFailedRun();
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    await ready(ui);
    for (const input of [KEYS.enter, KEYS.down, 'b', '误触', KEYS.enter]) ui.stdin.write(input);
    await waitFor(() => frame(ui).includes('完整详情'));
    ui.stdin.write(KEYS.escape);
    await ready(ui);
    expect(frame(ui)).not.toContain('备注：');
    expect(await project.artifacts.readBytes(`runs/${runId}/dispositions.json`)).toBeUndefined();
  });

  it('持锁结果加载期间返回被保护，完成后正常返回，避免立即重入争锁', async () => {
    const { project, runId } = await createFailedRun();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const read = project.artifacts.readBytes.bind(project.artifacts);
    vi.spyOn(project.artifacts, 'readBytes').mockImplementation(async (rel) => {
      if (rel === `runs/${runId}/input.json`) { entered.resolve(); await gate.promise; }
      return read(rel);
    });
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'runs' }} />);
    await waitFor(() => frame(ui).includes(runId));
    ui.stdin.write(KEYS.enter);
    await entered.promise;
    try {
      ui.stdin.write(KEYS.escape);
      await waitFor(() => frame(ui).includes('请等待结果加载完成'));
      expect(frame(ui)).not.toContain('选择运行');
    } finally { gate.resolve(); }
    await ready(ui);
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('选择运行'));
  });

  it('40×10 矮屏仍保留选中行、裁决选择和页脚', async () => {
    const { project, runId } = await createFailedRun(12);
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    resize(ui, 40, 10);
    await ready(ui);
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(10);
    expect(frame(ui)).toContain('Enter 详情');
    ui.stdin.write('c');
    await waitFor(() => frame(ui).includes('选择有问题的条款'));
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(10);
    expect(frame(ui)).toContain('Esc 取消');
  });

  it('b/f 备注持久化并回显，Esc 取消不写盘，备注中的 q 不退出', async () => {
    const { project, runId } = await createFailedRun();
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    await ready(ui);
    ui.stdin.write('f');
    await waitFor(() => frame(ui).includes('备注'));
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('已取消裁决'));
    expect(await project.artifacts.readBytes(`runs/${runId}/dispositions.json`)).toBeUndefined();
    ui.stdin.write('b');
    await waitFor(() => frame(ui).includes('备注'));
    ui.stdin.write('复现q错');
    ui.stdin.write('\u007f');
    try { await waitFor(() => frame(ui).includes('复现q') && !frame(ui).includes('复现q错')); }
    catch { throw new Error(`备注退格失败：${frame(ui)}`); }
    ui.stdin.write(KEYS.enter);
    await ready(ui, 'M-TC-1/E1 FAIL · 确认是 bug');
    expect(frame(ui)).toContain('已记录：确认是 bug');
    ui.stdin.write(KEYS.down);
    await ready(ui, '› M-TC-1/E2');
    ui.stdin.write('f');
    await waitFor(() => frame(ui).includes('备注'));
    ui.stdin.write('环境问题');
    ui.stdin.write(KEYS.enter);
    await ready(ui, 'M-TC-1/E2 DISPUTED · 误报');
    const file = await project.artifacts.readJson(`runs/${runId}/dispositions.json`, DispositionsFileSchema);
    expect(file?.items).toEqual([
      expect.objectContaining({ expectationId: 'E1', decision: 'confirmed_bug', note: '复现q' }),
      expect.objectContaining({ expectationId: 'E2', decision: 'false_positive', note: '环境问题' }),
    ]);
  });

  it('c 方向选择覆盖条款后提交，条款 unclear 并撤销确认', async () => {
    const { project, runId } = await createFailedRun();
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    await ready(ui);
    ui.stdin.write(KEYS.down);
    await ready(ui, '› M-TC-1/E2');
    ui.stdin.write('c');
    await waitFor(() => frame(ui).includes('选择有问题的条款'));
    ui.stdin.write(KEYS.down);
    await waitFor(() => frame(ui).includes('› 2) M-AC-2'));
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('备注') && frame(ui).includes('M-AC-2'));
    ui.stdin.write(KEYS.enter);
    await ready(ui, 'M-TC-1/E2 DISPUTED · 条款有问题');
    expect(frame(ui)).toContain('M-AC-2 已标记为 unclear');
    expect((await project.artifacts.loadClauses('M'))[1]?.status).toBe('unclear');
    expect((await Approvals.load(project.artifacts)).record('clause', 'M-AC-2')).toBeUndefined();
  });

  it('多于九个 covers 可输入完整编号，越界不提交，Esc 取消不改变预期选择', async () => {
    const { project, runId } = await createFailedRun();
    const rows = await loadResultRows(project.session, runId);
    rows[0]!.covers = Array.from({ length: 12 }, (_, i) => `M-AC-${i + 1}`);
    vi.spyOn(results, 'loadResultRows').mockResolvedValue(rows);
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    resize(ui, 40, 16);
    await ready(ui);
    ui.stdin.write('c');
    await waitFor(() => frame(ui).includes('选择有问题的条款'));
    ui.stdin.write('99');
    ui.stdin.write(KEYS.enter);
    try { await waitFor(() => frame(ui).includes('编号无效')); }
    catch { throw new Error(`编号提交失败：${frame(ui)}`); }
    ui.stdin.write('\u007f\u007f');
    ui.stdin.write('12');
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('备注') && frame(ui).includes('M-AC-12'));
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(16);
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('已取消裁决'));
    expect(frame(ui)).toContain('› M-TC-1/E1');
    expect(await project.artifacts.readBytes(`runs/${runId}/dispositions.json`)).toBeUndefined();
  });

  it.each([1, 12])('%i 个真实覆盖条款的选择与提交正确落盘', async (count) => {
    const { project, runId } = await createFailedRun(count);
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    await ready(ui);
    ui.stdin.write('c');
    if (count > 1) {
      await waitFor(() => frame(ui).includes('选择有问题的条款'));
      ui.stdin.write('1');
      ui.stdin.write('2');
      ui.stdin.write(KEYS.enter);
    }
    await waitFor(() => frame(ui).includes('备注'));
    ui.stdin.write(KEYS.enter);
    await ready(ui, 'M-TC-1/E1 FAIL · 条款有问题');
    const file = await project.artifacts.readJson(`runs/${runId}/dispositions.json`, DispositionsFileSchema);
    expect(file?.items[0]).toMatchObject({ expectationId: 'E1', clauseId: count === 1 ? 'M-AC-1' : 'M-AC-12' });
    expect((await project.artifacts.loadClauses('M'))[count - 1]?.status).toBe('unclear');
  });

  it.each(['empty', 'error'] as const)('裁决后延迟重载得到 %s，详情快照仍可关闭并恢复导航', async (outcome) => {
    const { project, runId } = await createFailedRun();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const load = results.loadResultRows;
    let calls = 0;
    vi.spyOn(results, 'loadResultRows').mockImplementation(async (...args) => {
      if (++calls === 1) return load(...args);
      entered.resolve();
      await gate.promise;
      if (outcome === 'error') throw new Error('延迟重载失败');
      return [];
    });
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    await ready(ui);
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('完整详情'));
    ui.stdin.write(KEYS.escape);
    await ready(ui);
    ui.stdin.write('b');
    await waitFor(() => frame(ui).includes('备注'));
    ui.stdin.write(KEYS.enter);
    await entered.promise;
    try {
      await waitFor(() => frame(ui).includes('加载中…'));
      ui.stdin.write(KEYS.enter);
      ui.stdin.write('s');
      await waitFor(() => frame(ui).includes('完整详情 · 操作状态'));
    } finally { gate.resolve(); }
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes(outcome === 'empty' ? '没有 FAIL 或 DISPUTED' : '延迟重载失败'));
    ui.stdin.write('q');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frames = ui.frames.length;
    ui.stdin.write(KEYS.down);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ui.frames.length).toBe(frames);
  });

  it('裁决写盘期间冻结选中行并阻止重复裁决、证据切换、返回、退出与 Ctrl+C', async () => {
    const { project, runId } = await createFailedRun();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const write = project.artifacts.writeJson.bind(project.artifacts);
    vi.spyOn(project.artifacts, 'writeJson').mockImplementation(async (rel, data) => {
      if (rel.endsWith('/dispositions.json')) { entered.resolve(); await gate.promise; }
      return write(rel, data);
    });
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    await ready(ui);
    ui.stdin.write('b');
    await waitFor(() => frame(ui).includes('备注'));
    ui.stdin.write(KEYS.down);
    ui.stdin.write(KEYS.enter);
    await entered.promise;
    try {
      for (const input of [KEYS.down, KEYS.tab, 'f', 'o', KEYS.enter, KEYS.escape, 'q', '\u0003']) ui.stdin.write(input);
      await waitFor(() => frame(ui).includes('请等待当前操作完成'));
      expect(frame(ui)).toContain('› M-TC-1/E1');
      expect(frame(ui)).not.toContain('完整详情');
    } finally { gate.resolve(); }
    await ready(ui, 'M-TC-1/E1 FAIL · 确认是 bug');
    const file = await project.artifacts.readJson(`runs/${runId}/dispositions.json`, DispositionsFileSchema);
    expect(file?.items).toEqual([expect.objectContaining({ expectationId: 'E1', decision: 'confirmed_bug' })]);
  });

  it('40×16 可滚动完整长理由、证据与历史备注，详情监听不移动列表或写裁决', async () => {
    const { project, runId } = await createFailedRun();
    const rows = await loadResultRows(project.session, runId);
    const row = rows[1]!;
    row.executor!.reasoning = `执行理由开头\n${'执行理由正文'.repeat(35)}\n执行理由末尾`;
    row.reviewer!.reasoning = `复核理由开头\n${'复核理由正文'.repeat(35)}\n复核理由末尾`;
    row.evidence[0]!.summary = `证据开头\n${'证据正文'.repeat(30)}\n证据末尾`;
    row.disposition = { caseId: row.caseId, expectationId: row.expectationId, decision: 'false_positive', note: '历史备注末尾', by: '历史审核人', at: '2026-11-16T00:00:00.000Z' };
    vi.spyOn(results, 'loadResultRows').mockResolvedValue(rows);
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    resize(ui, 40, 16);
    await ready(ui);
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(16);
    ui.stdin.write(KEYS.down);
    await ready(ui, '› M-TC-1/E2');
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('完整详情 · M-TC-1/E2'));
    await scrollTo(ui, '执行理由末尾');
    await scrollTo(ui, '复核理由末尾');
    await scrollTo(ui, '证据末尾');
    await scrollTo(ui, '历史备注末尾');
    ui.stdin.write('b');
    ui.stdin.write('c');
    ui.stdin.write(KEYS.escape);
    await ready(ui, '› M-TC-1/E2');
    expect(await project.artifacts.readBytes(`runs/${runId}/dispositions.json`)).toBeUndefined();
  });

  it('部分写入失败保留真实状态，40×16 可读取完整诊断，恢复后仍可选择', async () => {
    const { project, runId } = await createFailedRun();
    const write = project.artifacts.writeJson.bind(project.artifacts);
    vi.spyOn(project.artifacts, 'writeJson').mockImplementation(async (rel, value) => {
      if (rel.endsWith('/dispositions.json')) throw new Error(`注入写入故障${'长诊断'.repeat(30)}诊断末尾`);
      return write(rel, value);
    });
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    resize(ui, 40, 16);
    await ready(ui);
    ui.stdin.write('c');
    await waitFor(() => frame(ui).includes('选择有问题的条款'));
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('备注'));
    ui.stdin.write(KEYS.enter);
    await ready(ui);
    await waitFor(() => frame(ui).includes('处置流程未完成或部分完成'));
    expect(frame(ui).split('\n').length).toBeLessThanOrEqual(16);
    expect((await project.artifacts.loadClauses('M'))[0]?.status).toBe('unclear');
    ui.stdin.write('s');
    await waitFor(() => frame(ui).includes('完整详情 · 操作状态'));
    await scrollTo(ui, '磁盘裁决：未记录');
    await scrollTo(ui, '条款 M-AC-1：unclear');
    await scrollTo(ui, '条款确认：已撤销或无记录');
    await scrollTo(ui, '运行锁：已释放');
    await scrollTo(ui, '诊断末尾');
    ui.stdin.write(KEYS.escape);
    await ready(ui);
    ui.stdin.write(KEYS.down);
    await ready(ui, '› M-TC-1/E2');
  });

  it('空结果、缺失判定、无证据与加载错误不触发无效操作', async () => {
    const { project, runId } = await createFailedRun();
    const rows = await loadResultRows(project.session, runId);
    const load = vi.spyOn(results, 'loadResultRows').mockResolvedValue([]);
    const ui = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    await waitFor(() => frame(ui).includes('没有 FAIL 或 DISPUTED'));
    ui.stdin.write('b');
    expect(frame(ui)).not.toContain('备注');
    ui.unmount();
    load.mockResolvedValue([{ ...rows[0]!, executor: null, reviewer: null, covers: [], evidence: [] }]);
    const missing = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    await ready(missing);
    expect(frame(missing)).toContain('判定无效或缺失');
    expect(frame(missing)).toContain('无证据');
    missing.stdin.write(KEYS.tab);
    missing.stdin.write('o');
    missing.stdin.write('c');
    await waitFor(() => frame(missing).includes('没有覆盖条款'));
    missing.unmount();
    load.mockRejectedValue(new Error('快照校验失败'));
    const failed = render(<App env={{ session: project.session, editor, open }} initial={{ name: 'results', runId }} />);
    await waitFor(() => frame(failed).includes('快照校验失败'));
    expect(frame(failed)).toContain('Esc/q');
    expect(await project.artifacts.readBytes(`runs/${runId}/dispositions.json`)).toBeUndefined();
  });

  it.each(['导出', '启动'])('%s失败不宣称已显示证据，错误可读且输入恢复', async (stage) => {
    const { project, runId } = await createFailedRun();
    if (stage === '导出') {
      const write = project.artifacts.writeBytes.bind(project.artifacts);
      vi.spyOn(project.artifacts, 'writeBytes').mockImplementation(async (rel, bytes) => {
        if (rel.startsWith('.open/')) throw new Error('导出失败');
        return write(rel, bytes);
      });
    }
    const ui = render(<App env={{ session: project.session, editor, open: async () => { throw new Error('启动失败'); } }} initial={{ name: 'results', runId }} />);
    await ready(ui);
    ui.stdin.write('o');
    await waitFor(() => frame(ui).includes(`${stage}失败`));
    expect(frame(ui)).not.toContain('已请求打开');
    expect(frame(ui)).not.toContain('已打开');
    ui.stdin.write(KEYS.down);
    await ready(ui, '› M-TC-1/E2');
  });
});
