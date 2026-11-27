import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { unlinkSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore, ClauseSchema } from '@crosscheck/core';
import {
  ReviewSession, createEditorHost, createOpener, editValidated, openerCommand, parseCommandLine,
  parseYamlWith, resolveEditorCommand, stripErrorHeader, withErrorHeader, type EditorHost,
} from '../src/index';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function artifacts() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-io-'));
  roots.push(root);
  return new ArtifactStore(root);
}

describe('ReviewSession', () => {
  it('变更成功后写入 approvals.json，并规范确认人', async () => {
    const store = await artifacts();
    const session = await ReviewSession.open(store, ' 张三 ');
    expect(session.reviewer).toBe('张三');
    await session.mutate((a) => a.approve('clause', 'M-AC-1', { x: 1 }, session.reviewer));
    expect((await ReviewSession.open(store, '张三')).approvals.state('clause', 'M-AC-1', { x: 1 })).toBe('approved');
  });
  it('跨会话修改保留新确认和撤销的不同条目', async () => {
    const store = await artifacts();
    const first = await ReviewSession.open(store, '甲');
    await first.mutate((a) => a.approve('profile', 'pages.yaml', {}, '甲'));
    const second = await ReviewSession.open(store, '乙');
    await second.mutate((a) => {
      a.revoke('profile', 'pages.yaml');
      a.approve('profile', 'api-catalog.yaml', {}, '乙');
    });
    await first.mutate((a) => a.approve('profile', 'auth.yaml', {}, '甲'));
    const latest = (await ReviewSession.open(store, '甲')).approvals;
    expect(latest.record('profile', 'pages.yaml')).toBeUndefined();
    expect(latest.record('profile', 'api-catalog.yaml')?.by).toBe('乙');
    expect(latest.record('profile', 'auth.yaml')?.by).toBe('甲');
  });
  it.each([false, true])('拒绝覆盖同条目人工更改（发生于动作中：%s）', async (during) => {
    const store = await artifacts();
    const first = await ReviewSession.open(store, '甲');
    const second = await ReviewSession.open(store, '乙');
    const otherApproval = () => second.mutate((a) => a.approve('profile', 'pages.yaml', {}, '乙'));
    if (!during) await otherApproval();
    await expect(first.mutate(async (a) => {
      a.revoke('profile', 'pages.yaml');
      if (during) await otherApproval();
    })).rejects.toThrow(/确认记录.*变化/);
    expect((await ReviewSession.open(store, '甲')).approvals.record('profile', 'pages.yaml')?.by).toBe('乙');
    expect(first.approvals.record('profile', 'pages.yaml')?.by).toBe('乙');
  });
  it('变更失败时丢弃内存中的半成品', async () => {
    const session = await ReviewSession.open(await artifacts(), '张三');
    await expect(session.mutate((a) => {
      a.approve('clause', 'M-AC-1', { x: 1 }, '张三');
      throw new Error('写入失败');
    })).rejects.toThrow('写入失败');
    expect(session.approvals.state('clause', 'M-AC-1', { x: 1 })).toBe('none');
    await session.mutate((a) => a.approve('clause', 'M-AC-2', {}, '张三'));
    expect(session.approvals.state('clause', 'M-AC-2', {})).toBe('approved');
  });
  it('确认人不能为空', async () => {
    await expect(ReviewSession.open(await artifacts(), ' ')).rejects.toThrow(/确认人/);
  });
  it('同会话忙碌时拒绝第二个动作，避免保存未完成确认', async () => {
    const store = await artifacts();
    const session = await ReviewSession.open(store, '张三');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = session.mutate(async (a) => {
      a.approve('clause', 'M-AC-1', { x: 1 }, '张三');
      await gate;
      throw new Error('首动作失败');
    });
    let secondRan = false;
    try {
      await expect(session.mutate(() => { secondRan = true; })).rejects.toThrow(/忙碌/);
      expect(secondRan).toBe(false);
      expect(await store.readBytes('approvals.json')).toBeUndefined();
    } finally {
      release();
      await expect(first).rejects.toThrow('首动作失败');
    }
    expect(session.approvals.state('clause', 'M-AC-1', { x: 1 })).toBe('none');
  });
  it('失败后磁盘重载也失败时，不暴露半成品或允许后续动作覆盖确认', async () => {
    const store = await artifacts();
    const session = await ReviewSession.open(store, '张三');
    vi.spyOn(store, 'readJson').mockRejectedValue(new Error('读取失败'));
    await expect(session.mutate((a) => {
      a.approve('clause', 'M-AC-1', {}, '张三');
      throw new Error('动作失败');
    })).rejects.toThrow();
    expect(() => session.approvals).toThrow(/重新打开/);
    let ran = false;
    await expect(session.mutate(() => { ran = true; })).rejects.toThrow();
    expect(ran).toBe(false);
    expect(await store.readBytes('approvals.json')).toBeUndefined();
  });
  it('工件已写但确认保存失败时，重载仍真实反映确认失效，不回滚工件', async () => {
    const store = await artifacts();
    const session = await ReviewSession.open(store, '张三');
    await store.writeJson('item.json', { x: 1 });
    await session.mutate((a) => a.approve('clause', 'M-AC-1', { x: 1 }, '张三'));
    const writeJson = store.writeJson.bind(store);
    vi.spyOn(store, 'writeJson').mockImplementation(async (rel, data) => {
      if (rel === 'approvals.json') throw new Error('确认落盘失败');
      await writeJson(rel, data);
    });
    await expect(session.mutate((a, stageWrite) => {
      stageWrite('clause', 'M-AC-1', () => store.writeJson('item.json', { x: 2 }));
      a.approve('clause', 'M-AC-1', { x: 2 }, '张三');
    })).rejects.toThrow('确认落盘失败');
    expect(JSON.parse((await store.readBytes('item.json'))!.toString())).toEqual({ x: 2 });
    expect(session.approvals.state('clause', 'M-AC-1', { x: 2 })).toBe('stale');
    expect((await ReviewSession.open(store, '张三')).approvals.state('clause', 'M-AC-1', { x: 2 })).toBe('stale');
  });
});

describe('编辑器', () => {
  it('解析命令行，支持双引号和空参数，保留反斜杠且不展开 shell', () => {
    expect(parseCommandLine('code --wait')).toEqual(['code', '--wait']);
    expect(parseCommandLine('"C:\\Program Files\\Ed\\ed.exe" -n')).toEqual(['C:\\Program Files\\Ed\\ed.exe', '-n']);
    expect(parseCommandLine('ed "" "a b" ; $HOME')).toEqual(['ed', '', 'a b', ';', '$HOME']);
    expect(() => parseCommandLine('"abc')).toThrow(/引号/);
  });
  it('VISUAL 优先于 EDITOR，空白回退，都没有时返回 undefined', () => {
    expect(resolveEditorCommand({ VISUAL: 'vim', EDITOR: 'nano' })).toEqual({ program: 'vim', args: [] });
    expect(resolveEditorCommand({ EDITOR: 'notepad' })).toEqual({ program: 'notepad', args: [] });
    expect(resolveEditorCommand({ VISUAL: ' ', EDITOR: 'nano' })).toEqual({ program: 'nano', args: [] });
    expect(resolveEditorCommand({ VISUAL: ' ' })).toBeUndefined();
  });
  it('没有编辑器时提示设置环境变量', async () => {
    await expect(createEditorHost(await artifacts(), {}).edit('a')).rejects.toThrow(/EDITOR/);
  });
  it('临时 YAML 仅在 .crosscheck/.edit，继承终端、不经 shell，读回后删除', async () => {
    const store = await artifacts();
    const host = createEditorHost(store, { EDITOR: '"C:\\Program Files\\Ed\\ed.exe" --wait' }, (program, args, options) => {
      expect(program).toBe('C:\\Program Files\\Ed\\ed.exe');
      expect(args[0]).toBe('--wait');
      expect(options).toEqual({ stdio: 'inherit', shell: false });
      const file = args.at(-1)!;
      expect(path.dirname(file)).toBe(store.resolve('.edit'));
      expect(path.extname(file)).toBe('.yaml');
      writeFileSync(file, '改过的内容');
      return { status: 0 };
    });
    expect(await host.edit('原内容')).toBe('改过的内容');
    expect(await readdir(store.resolve('.edit'))).toEqual([]);
  });
  it.each([
    ['非零退出', () => ({ status: 1 }), /退出码 1/],
    ['启动失败', () => ({ status: null, error: new Error('ENOENT') }), /无法启动编辑器/],
    ['启动抛错', () => { throw new Error('启动异常'); }, /启动异常/],
  ] as const)('%s 时也清理临时文件', async (_name, spawn, error) => {
    const store = await artifacts();
    await expect(createEditorHost(store, { EDITOR: 'ed' }, spawn).edit('x')).rejects.toThrow(error);
    expect(await readdir(store.resolve('.edit'))).toEqual([]);
  });
  it('编辑器删除临时文件时明确报错，不能当作空内容保存', async () => {
    const store = await artifacts();
    const host = createEditorHost(store, { EDITOR: 'ed' }, (_program, args) => {
      unlinkSync(args.at(-1)!);
      return { status: 0 };
    });
    await expect(host.edit('原内容')).rejects.toThrow(/临时文件.*不存在/);
  });
  it('编辑器确实保存零字节文件时返回空串', async () => {
    const store = await artifacts();
    const host = createEditorHost(store, { EDITOR: 'ed' }, (_program, args) => {
      writeFileSync(args.at(-1)!, '');
      return { status: 0 };
    });
    expect(await host.edit('原内容')).toBe('');
    expect(await store.list('.edit')).toEqual([]);
  });
  it.each([false, true])('清理失败报告残留路径，并保留原异常（编辑失败=%s）', async (editFails) => {
    const store = await artifacts();
    const cleanupError = new Error('拒绝删除');
    const original = new Error('编辑器故障');
    vi.spyOn(store, 'remove').mockRejectedValue(cleanupError);
    let file = '';
    const host = createEditorHost(store, { EDITOR: 'ed' }, (_program, args) => {
      file = args.at(-1)!;
      if (editFails) throw original;
      return { status: 0 };
    });
    const error = await host.edit('原内容').then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(file);
    expect((error as Error).message).toContain('清理');
    if (editFails) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toContain(original);
      expect((error as AggregateError).errors).toContain(cleanupError);
    } else {
      expect((error as Error).cause).toBe(cleanupError);
    }
    expect(await store.list('.edit')).toHaveLength(1);
  });
  it('临时文件写入后报告失败也清理', async () => {
    const store = await artifacts();
    const writeBytes = store.writeBytes.bind(store);
    vi.spyOn(store, 'writeBytes').mockImplementation(async (rel, bytes) => {
      await writeBytes(rel, bytes);
      throw new Error('写后失败');
    });
    await expect(createEditorHost(store, { EDITOR: 'ed' }).edit('x')).rejects.toThrow('写后失败');
    expect(await readdir(store.resolve('.edit'))).toEqual([]);
  });
});

describe('editValidated', () => {
  const script = (outputs: string[]): EditorHost & { seen: string[] } => {
    const seen: string[] = [];
    return { seen, async edit(text) { seen.push(text); return outputs.shift() ?? text; } };
  };
  const parse = (text: string) => parseYamlWith(text, ClauseSchema);
  const valid = 'id: M-AC-1\ntext: 条款\nsource:\n  file: a.md\n  line: 1\n  excerpt: 原\n';

  it('未修改即取消', async () => {
    expect(await editValidated(script([valid]), valid, parse)).toEqual({ status: 'cancelled' });
  });
  it('原样关闭时保留用户原有 #! 注释并取消', async () => {
    const initial = '#! 用户注释\n#! 第二行\n' + valid;
    expect(await editValidated(script([]), initial, parse)).toEqual({ status: 'cancelled' });
    expect(stripErrorHeader(initial)).toBe(initial);
  });
  it.each([false, true])('失败重开后仅去掉本轮诊断，保留连续用户注释（修正=%s）', async (fix) => {
    const notes = '#! 用户注释\n#! 需要保留的第二行\n';
    let calls = 0;
    const editor: EditorHost = {
      async edit(text) {
        calls++;
        if (calls === 1) return notes + valid.replace('M-AC-1', 'bad');
        expect(text).toContain('#! 校验失败');
        if (calls > 2) throw new Error('不应继续重新打开');
        return fix ? text.replace('id: bad', 'id: M-AC-1') : text;
      },
    };
    const outcome = await editValidated(editor, notes + valid, parse);
    expect(outcome).toEqual(fix
      ? { status: 'saved', value: ClauseSchema.parse({ id: 'M-AC-1', text: '条款', source: { file: 'a.md', line: 1, excerpt: '原' } }), text: notes + valid }
      : { status: 'cancelled' });
    expect(calls).toBe(2);
  });
  it('校验失败时带错误头重新打开，修正后保存', async () => {
    const editor = script(['id: bad\n', valid.replace('条款', '新条款')]);
    const outcome = await editValidated(editor, valid, parse);
    expect(outcome).toMatchObject({ status: 'saved', value: { text: '新条款' }, text: valid.replace('条款', '新条款') });
    expect(editor.seen[1]).toContain('#! 校验失败');
    expect(stripErrorHeader(editor.seen[1]!)).toBe('id: bad\n');
  });
  it('出错后原样关闭即放弃', async () => {
    const editor = script(['id: bad\n']);
    expect(await editValidated(editor, valid, parse)).toEqual({ status: 'cancelled' });
    expect(editor.seen).toHaveLength(2);
  });
  it('CRLF 与 LF 视为相同内容', async () => {
    expect(await editValidated(script([valid.replace(/\n/g, '\r\n')]), valid, parse)).toEqual({ status: 'cancelled' });
  });
  it('YAML 语法错误给出可读提示，错误头每行都是注释', () => {
    expect(parseYamlWith('a: [1,', ClauseSchema)).toMatchObject({ ok: false, error: expect.stringContaining('YAML 语法错误') });
    expect(withErrorHeader('第一行\n第二行', 'body')).toBe('#! 校验失败，修正后保存；不做修改直接关闭即放弃：\n#! 第一行\n#! 第二行\n#! 校验诊断结束\nbody');
  });
});

describe('系统打开', () => {
  it('按平台选择命令，不经过 shell', () => {
    expect(openerCommand('win32', 'C:\\a b\\x.png')).toEqual({ program: 'explorer.exe', args: ['C:\\a b\\x.png'] });
    expect(openerCommand('darwin', '/x.png')).toEqual({ program: 'open', args: ['/x.png'] });
    expect(openerCommand('linux', '/x.png')).toEqual({ program: 'xdg-open', args: ['/x.png'] });
  });
  it('启动失败时拒绝', async () => {
    const open = createOpener('linux', () => {
      const child = Object.assign(new EventEmitter(), { unref() {} });
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    });
    await expect(open('/x.png')).rejects.toThrow(/无法打开证据/);
  });
  it('同步启动失败也报告无法打开证据', async () => {
    await expect(createOpener('linux', () => { throw new Error('同步失败'); })('/x.png')).rejects.toThrow(/无法打开证据/);
  });
  it.each(['darwin', 'linux'] as const)('%s 启动后仍等待关闭，零退出才完成', async (platform) => {
    const child = Object.assign(new EventEmitter(), { unref() {} });
    const open = createOpener(platform, () => child);
    let settled = false;
    const pending = open('/x.png').then(() => { settled = true; });
    child.emit('spawn');
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', 0, null);
    await pending;
    expect(settled).toBe(true);
  });
  it.each([
    ['darwin', 1, null], ['linux', 3, null], ['linux', null, 'SIGTERM'],
  ] as const)('%s 启动后关闭异常（%s/%s）必须拒绝', async (platform, code, signal) => {
    const child = Object.assign(new EventEmitter(), { unref() {} });
    const pending = createOpener(platform, () => child)('/x.png');
    const assertion = expect(pending).rejects.toThrow(/无法打开证据/);
    child.emit('spawn');
    child.emit('close', code, signal);
    await assertion;
  });
  it('Windows 只确认启动并 unref，参数完整传递且明确禁用 shell', async () => {
    let unref = false;
    const open = createOpener('win32', (program, args, options) => {
      expect(program).toBe('explorer.exe');
      expect(args).toEqual(['C:\\a b\\x.png']);
      expect(options).toEqual({ detached: true, stdio: 'ignore', shell: false });
      const child = Object.assign(new EventEmitter(), { unref() { unref = true; } });
      setImmediate(() => child.emit('spawn'));
      return child;
    });
    await open('C:\\a b\\x.png');
    expect(unref).toBe(true);
  });
});
