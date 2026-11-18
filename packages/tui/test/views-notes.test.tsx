import { Approvals } from '@crosscheck/core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, initialRoute, type EditorHost } from '../src/index';
import { approveNotes, editNotes, loadNotesOverview, revokeNotes, validateNotesText } from '../src/state/notes';
import { cleanupProjects, createProject } from './fixture';
import { deferred, KEYS, waitFor } from './helpers';

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await cleanupProjects(); });
const noEditor: EditorHost = { async edit() { throw new Error('缺少编辑器'); } };
const open = async () => {};
const frame = (ui: ReturnType<typeof render>) => ui.lastFrame() ?? '';
const NOTES = '# 项目笔记\n\n人工补充';
async function projectWithNotes() {
  const project = await createProject();
  await project.artifacts.writeBytes('notes.md', Buffer.from(NOTES));
  return project;
}

describe('项目笔记审核', () => {
  it('首页进入笔记审核并查看安全的只读详情，确认及撤销落盘', async () => {
    const { session, artifacts } = await projectWithNotes();
    const text = `${NOTES}\n控制: \u001b[31m末尾\u009b`;
    await artifacts.writeBytes('notes.md', Buffer.from(text));
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'home' }} />);
    await waitFor(() => frame(ui).includes('项目笔记审核'));
    ui.stdin.write(KEYS.up);
    await waitFor(() => frame(ui).includes('› 项目笔记审核'));
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('notes.md'));
    ui.stdin.write(KEYS.enter);
    await waitFor(() => frame(ui).includes('完整详情 · notes.md'));
    expect(frame(ui)).toContain('末尾');
    expect(frame(ui)).not.toContain('\u001b');
    expect(frame(ui)).not.toContain('\u009b');
    ui.stdin.write('a');
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
    ui.stdin.write(KEYS.escape);
    await waitFor(() => frame(ui).includes('项目笔记审核'));
    ui.stdin.write('a');
    await waitFor(() => frame(ui).includes('已确认项目笔记'));
    expect((await Approvals.load(artifacts)).state('notes', 'project', text)).toBe('approved');
    ui.stdin.write('r');
    await waitFor(() => frame(ui).includes('已撤销项目笔记'));
    expect((await Approvals.load(artifacts)).record('notes', 'project')).toBeUndefined();
    expect(initialRoute('notes')).toEqual({ name: 'notes' });
  });

  it('确认须先查看笔记，外部修改后拒绝确认并要求查看新内容', async () => {
    const { session, artifacts } = await projectWithNotes();
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'notes' }} />);
    await waitFor(() => frame(ui).includes('notes.md 未确认'));
    ui.stdin.write('a'); await waitFor(() => frame(ui).includes('请先查看'));
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
    ui.stdin.write(KEYS.enter); await waitFor(() => frame(ui).includes('完整详情'));
    ui.stdin.write(KEYS.escape); await waitFor(() => frame(ui).includes('notes.md 未确认'));
    await artifacts.writeBytes('notes.md', Buffer.from('# 新内容'));
    ui.stdin.write('a'); await waitFor(() => frame(ui).includes('已变化'));
    expect((await Approvals.load(artifacts)).record('notes', 'project')).toBeUndefined();
    await waitFor(() => frame(ui).includes('notes.md 未确认'));
    ui.stdin.write('a'); await waitFor(() => frame(ui).includes('请先查看'));
    ui.stdin.write(KEYS.enter); await waitFor(() => frame(ui).includes('# 新内容'));
    ui.stdin.write(KEYS.escape); await waitFor(() => frame(ui).includes('notes.md 未确认'));
    ui.stdin.write('a'); await waitFor(() => frame(ui).includes('已确认项目笔记'));
    expect((await Approvals.load(artifacts)).state('notes', 'project', '# 新内容')).toBe('approved');
  });

  it('加载尚未完成时不允许确认', async () => {
    const { session, artifacts } = await projectWithNotes();
    const gate = deferred<void>(); const entered = deferred<void>();
    const read = artifacts.readBytes.bind(artifacts);
    vi.spyOn(artifacts, 'readBytes').mockImplementation(async (rel) => {
      if (rel === 'notes.md') { entered.resolve(); await gate.promise; }
      return read(rel);
    });
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'notes' }} />);
    await entered.promise;
    ui.stdin.write('a'); await waitFor(() => frame(ui).includes('请先查看'));
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
    gate.resolve(); await waitFor(() => frame(ui).includes('notes.md 未确认'));
  });

  it('标题必须在同一行包含非空内容', () => {
    for (const value of ['# ', '#\n正文', '## \t\r\n正文', '# ###', '## #  ', '#\t####\r\n正文']) expect(() => validateNotesText(value)).toThrow();
    expect(validateNotesText('# 标题\r\n正文')).toBe('# 标题\r\n正文');
    expect(validateNotesText('# 标题 ###')).toBe('# 标题 ###');
    expect(validateNotesText('# #标题')).toBe('# #标题');
  });

  it('非法 UTF-8 不得查看、确认或编辑，替换字符不能产生哈希混淆', async () => {
    const { session, artifacts } = await projectWithNotes();
    await artifacts.writeBytes('notes.md', Buffer.concat([Buffer.from('# 标题\n'), Buffer.from([0xff])]));
    await expect(loadNotesOverview(session)).rejects.toThrow('UTF-8');
    await expect(approveNotes(session, NOTES)).rejects.toThrow('UTF-8');
    await expect(editNotes(session, noEditor)).rejects.toThrow('UTF-8');
    expect((await Approvals.load(artifacts)).record('notes', 'project')).toBeUndefined();
  });

  it('CRLF 详情按行显示且其他控制字符安全转义', async () => {
    const { session, artifacts } = await projectWithNotes();
    await artifacts.writeBytes('notes.md', Buffer.from('# 标题\r\n第二行\r\n控制\u001b结束'));
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'notes' }} />);
    await waitFor(() => frame(ui).includes('notes.md'));
    ui.stdin.write(KEYS.enter); await waitFor(() => frame(ui).includes('第二行'));
    expect(frame(ui)).not.toContain('\\u000d');
    expect(frame(ui)).toContain('\\u001b');
    expect(frame(ui)).not.toContain('\u001b');
  });

  it('编辑后保留原确认记录并显示失效', async () => {
    const { session, artifacts } = await projectWithNotes();
    const editor: EditorHost = { async edit(text) { return `${text}\n<!-- 人工补充 -->`; } };
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'notes' }} />);
    await waitFor(() => frame(ui).includes('notes.md'));
    ui.stdin.write(KEYS.enter); await waitFor(() => frame(ui).includes('完整详情'));
    ui.stdin.write(KEYS.escape); await waitFor(() => frame(ui).includes('notes.md 未确认'));
    ui.stdin.write('a'); await waitFor(() => frame(ui).includes('已确认项目笔记'));
    ui.stdin.write('e'); await waitFor(() => frame(ui).includes('已保存 notes.md') && frame(ui).includes('确认已失效'));
    const text = (await artifacts.readBytes('notes.md'))!.toString();
    expect(text).toBe(`${NOTES}\n<!-- 人工补充 -->`);
    expect((await Approvals.load(artifacts)).state('notes', 'project', text)).toBe('stale');
  });

  it('校验失败进入编辑重试，取消不保存', async () => {
    const { session, artifacts } = await projectWithNotes();
    let calls = 0;
    const editor: EditorHost = { async edit(text) { calls++; return calls === 1 ? '没有标题' : text; } };
    expect(await editNotes(session, editor)).toBe('未修改');
    expect(calls).toBe(2);
    expect((await artifacts.readBytes('notes.md'))?.toString()).toBe(NOTES);
    expect(() => validateNotesText('')).toThrow();
    expect(() => validateNotesText('没有标题')).toThrow();
    expect(() => validateNotesText(`# 标题\n${'中'.repeat(22000)}`)).toThrow();
    expect(validateNotesText('# 标题')).toBe('# 标题');
  });

  it('界面编辑非法内容后修正，保存修正后的原文', async () => {
    const { session, artifacts } = await projectWithNotes();
    let calls = 0;
    const editor: EditorHost = { async edit(text) {
      calls++;
      if (calls === 1) return '无标题';
      expect(text).toContain('校验失败');
      return '# 修正后的笔记';
    } };
    const ui = render(<App env={{ session, editor, open }} initial={{ name: 'notes' }} />);
    await waitFor(() => frame(ui).includes('notes.md'));
    ui.stdin.write('e');
    await waitFor(() => frame(ui).includes('已保存 notes.md'));
    expect((await artifacts.readBytes('notes.md'))?.toString()).toBe('# 修正后的笔记');
    expect(calls).toBe(2);
  });

  it('直接调用确认也必须提供并匹配已查看文本', async () => {
    const { session, artifacts } = await projectWithNotes();
    const untyped = approveNotes as unknown as (reviewSession: typeof session) => Promise<string>;
    await expect(untyped(session)).rejects.toThrow('查看');
    await expect(approveNotes(session, '# 旧版本')).rejects.toThrow('变化');
    expect((await Approvals.load(artifacts)).record('notes', 'project')).toBeUndefined();
    await approveNotes(session, NOTES);
    expect((await Approvals.load(artifacts)).state('notes', 'project', NOTES)).toBe('approved');
  });

  it('确认时重新读取和校验原文，修改产生 stale，撤销清除记录', async () => {
    const { session, artifacts } = await projectWithNotes();
    expect((await loadNotesOverview(session)).status).toBe('none');
    await artifacts.writeBytes('notes.md', Buffer.from('无标题'));
    await expect(approveNotes(session, '无标题')).rejects.toThrow();
    expect((await Approvals.load(artifacts)).record('notes', 'project')).toBeUndefined();
    await artifacts.writeBytes('notes.md', Buffer.from(NOTES));
    await approveNotes(session, NOTES);
    expect((await loadNotesOverview(session)).status).toBe('approved');
    await artifacts.writeBytes('notes.md', Buffer.from('# 篡改'));
    expect((await loadNotesOverview(session)).status).toBe('stale');
    await revokeNotes(session);
    expect((await loadNotesOverview(session)).status).toBe('none');
  });

  it('缺失文件不可确认，缺失期间被创建不得被编辑覆盖', async () => {
    const { session, artifacts } = await createProject();
    const ui = render(<App env={{ session, editor: noEditor, open }} initial={{ name: 'notes' }} />);
    await waitFor(() => frame(ui).includes('不存在'));
    ui.stdin.write('a'); await waitFor(() => frame(ui).includes('请先查看'));
    await expect(approveNotes(session, NOTES)).rejects.toThrow('不存在');
    expect((await Approvals.load(artifacts)).record('notes', 'project')).toBeUndefined();
    const editor: EditorHost = { async edit() { await artifacts.writeBytes('notes.md', Buffer.from('# 他人')); return '# 我的'; } };
    await expect(editNotes(session, editor)).rejects.toThrow('变化');
    expect((await artifacts.readBytes('notes.md'))?.toString()).toBe('# 他人');
  });

  it('编辑期间文件变化或删除时不覆盖', async () => {
    const { session, artifacts } = await projectWithNotes();
    const entered = deferred<void>(); const gate = deferred<void>();
    const editor: EditorHost = { async edit() { entered.resolve(); await gate.promise; return '# 我的'; } };
    const pending = editNotes(session, editor);
    await entered.promise;
    await artifacts.writeBytes('notes.md', Buffer.from('# 他人'));
    gate.resolve();
    await expect(pending).rejects.toThrow('变化');
    expect((await artifacts.readBytes('notes.md'))?.toString()).toBe('# 他人');
  });

  it('编辑期间文件被删除时不重新创建', async () => {
    const { session, artifacts } = await projectWithNotes();
    const editor: EditorHost = { async edit() { await artifacts.remove('notes.md'); return '# 我的'; } };
    await expect(editNotes(session, editor)).rejects.toThrow('变化');
    expect(await artifacts.readBytes('notes.md')).toBeUndefined();
  });
});
