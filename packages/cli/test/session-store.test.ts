import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectUsageLocation } from '@crosscheck/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { SessionStore } from '../src/session-store';

vi.mock('node:fs/promises', { spy: true });
vi.mock('node:os', { spy: true });

let home: string;
let project: string;
let store: SessionStore;
let id: string;

beforeEach(async () => {
  home = await fs.realpath(await mkdtemp(path.join(tmpdir(), 'crosscheck-session-')));
  project = path.join(home, 'project');
  await mkdir(project);
  store = new SessionStore(project, home);
  id = randomUUID();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function sessionDirectory() {
  const { directory } = await projectUsageLocation(project, home);
  return path.join(path.dirname(directory), 'sessions', id);
}

const begin = { kind: 'begin', operation: 'chat', input: '你好' } as const;
const end = { kind: 'end', begin: 1, status: 'success', output: '界面回复', reply: '模型回复' } as const;

async function completeChat() {
  await store.append(id, 0, begin);
  return store.append(id, 1, end);
}

describe('SessionStore', () => {
  it('不存在会话时返回空列表和 null，且不创建存储目录', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.load(id)).toBeNull();
    expect(await readdir(home)).toEqual(['project']);
  });

  it('拒绝非 UUID 的 ID', async () => {
    await expect(store.load('../other')).rejects.toMatchObject({ code: 'invalid-id' });
    await expect(store.append('../other', 0, begin)).rejects.toMatchObject({ code: 'invalid-id' });
  });

  it('从磁盘往返成功聊天并分离界面输出和模型上下文', async () => {
    const committed = await completeChat();
    const restored = await new SessionStore(project, home).load(id.toUpperCase());
    expect(restored).toEqual(committed);
    expect(restored).toMatchObject({
      id, revision: 2, readonly: false, diagnostics: [], unfinishedBegins: [],
      entries: [{ ...begin, revision: 1 }, { ...end, revision: 2 }],
      history: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '模型回复' }],
    });
    expect(restored?.createdAt).toBe(restored?.entries[0]?.time);
    expect(restored?.updatedAt).toBe(restored?.entries[1]?.time);
  });

  it('命令和失败或取消的聊天均只保留界面记录', async () => {
    await store.append(id, 0, { kind: 'begin', operation: 'slash', input: '/run' });
    await store.append(id, 1, { kind: 'end', begin: 1, status: 'error', output: '命令失败' });
    await store.append(id, 2, { kind: 'begin', operation: 'slash', input: '/usage' });
    await store.append(id, 3, { kind: 'end', begin: 3, status: 'success', output: '命令成功' });
    await store.append(id, 4, begin);
    await store.append(id, 5, { kind: 'end', begin: 5, status: 'error', output: '聊天失败' });
    await store.append(id, 6, begin);
    const result = await store.append(id, 7, { kind: 'end', begin: 7, status: 'cancelled', output: '聊天中断' });
    expect(result.history).toEqual([]);
    expect(result.unfinishedBegins).toEqual([]);
    expect(result.entries).toHaveLength(8);
  });

  it.each([
    { kind: 'end', begin: 1, status: 'success', output: '' },
    { kind: 'end', begin: 1, status: 'error', output: '', reply: '不能保留' },
  ] as const)('拒绝不符合当前聊天状态的结束记录：%j', async entry => {
    await store.append(id, 0, begin);
    await expect(store.append(id, 1, entry)).rejects.toMatchObject({ code: 'invalid-entry' });
    expect((await store.load(id))?.revision).toBe(1);
  });

  it.each([false, true])('同步新建目录的父级及已链接的修订；提交后同步失败不变成追加失败（故障：%s）', async fail => {
    const directory = await sessionDirectory();
    const synced: Array<{ folder: string; committed: boolean }> = [];
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const platform = vi.mocked(os.platform).mockReturnValue('linux');
    const opened = vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (flags !== 'r') return actual.open(name, flags, mode);
      const folder = String(name);
      return {
        sync: async () => {
          const committed = (await actual.readdir(directory)).includes('1.json');
          synced.push({ folder, committed });
          if (committed && fail) throw Object.assign(new Error('目录 I/O 失败'), { code: 'EIO' });
        },
        close: async () => {},
      } as Awaited<ReturnType<typeof fs.open>>;
    });
    try {
      const warning = vi.fn();
      const committed = await store.append(id, 0, begin, warning);
      expect(await store.load(id)).toMatchObject({ revision: 1, entries: committed.entries });
      expect(synced.slice(0, 5)).toEqual([
        { folder: path.dirname(directory), committed: false },
        { folder: path.resolve(directory, '..', '..'), committed: false },
        { folder: path.join(home, '.crosscheck', 'projects'), committed: false },
        { folder: path.join(home, '.crosscheck'), committed: false },
        { folder: home, committed: false },
      ]);
      expect(synced[5]).toEqual({ folder: path.dirname(home), committed: false });
      expect(synced.slice(-2)).toEqual([
        { folder: path.parse(home).root, committed: false },
        { folder: directory, committed: true },
      ]);
      if (fail) expect(warning).toHaveBeenCalledWith(expect.stringContaining('会话修订已提交'));
      else expect(warning).not.toHaveBeenCalled();
      expect(await store.append(id, 1, end)).toMatchObject({ revision: 2 });
    } finally { opened.mockRestore(); platform.mockRestore(); }
  });

  it('首次父目录同步遇到真实 I/O 错误时，不提交修订且可以原版本重试', async () => {
    const directory = await sessionDirectory();
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const platform = vi.mocked(os.platform).mockReturnValue('linux');
    let fail = true;
    const opened = vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (flags !== 'r') return actual.open(name, flags, mode);
      return {
        sync: async () => {
          if (String(name) === path.dirname(directory) && fail) throw Object.assign(new Error('父目录 I/O 失败'), { code: 'EIO' });
        },
        close: async () => {},
      } as Awaited<ReturnType<typeof fs.open>>;
    });
    try {
      await expect(store.append(id, 0, begin)).rejects.toMatchObject({ code: 'EIO' });
      expect(await store.load(id)).toBeNull();
      fail = false;
      expect(await store.append(id, 0, begin)).toMatchObject({ revision: 1 });
    } finally { opened.mockRestore(); platform.mockRestore(); }
  });

  it('重试时仍同步首次创建的 home 祖先，祖先未同步前不提交修订', async () => {
    const newHome = path.join(home, 'new-parent', 'new-home');
    const writing = new SessionStore(project, newHome);
    const { directory: usage } = await projectUsageLocation(project, newHome);
    const directory = path.join(path.dirname(usage), 'sessions', id);
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const platform = vi.mocked(os.platform).mockReturnValue('linux');
    let fail = true;
    const opened = vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (flags !== 'r') return actual.open(name, flags, mode);
      return {
        sync: async () => {
          if (String(name) === home && fail) throw Object.assign(new Error('祖先目录 I/O 失败'), { code: 'EIO' });
        },
        close: async () => {},
      } as Awaited<ReturnType<typeof fs.open>>;
    });
    try {
      await expect(writing.append(id, 0, begin)).rejects.toMatchObject({ code: 'EIO' });
      expect(await actual.readdir(directory)).toEqual([]);
      await expect(new SessionStore(project, newHome).append(id, 0, begin)).rejects.toMatchObject({ code: 'EIO' });
      expect(await writing.load(id)).toBeNull();
      fail = false;
      expect(await writing.append(id, 0, begin)).toMatchObject({ revision: 1 });
    } finally { opened.mockRestore(); platform.mockRestore(); }
  });

  it('冷启动遇到已存在但未同步的 home 祖先时，不能跳过同步并提交', async () => {
    const newHome = path.join(home, 'preexisting-parent', 'new-home');
    const { directory: usage } = await projectUsageLocation(project, newHome);
    const directory = path.join(path.dirname(usage), 'sessions', id);
    // 模拟另一个进程已完成 mkdir，却在同步祖先前退出；当前进程没有任何创建记录。
    await mkdir(directory, { recursive: true });
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const platform = vi.mocked(os.platform).mockReturnValue('linux');
    let fail = true;
    const opened = vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (flags !== 'r') return actual.open(name, flags, mode);
      return {
        sync: async () => {
          if (String(name) === home && fail) throw Object.assign(new Error('祖先目录 I/O 失败'), { code: 'EIO' });
        },
        close: async () => {},
      } as Awaited<ReturnType<typeof fs.open>>;
    });
    try {
      const writing = new SessionStore(project, newHome);
      await expect(writing.append(id, 0, begin)).rejects.toMatchObject({ code: 'EIO' });
      expect(await actual.readdir(directory)).toEqual([]);
      fail = false;
      await expect(writing.append(id, 0, begin)).resolves.toMatchObject({ revision: 1 });
      expect(await new SessionStore(project, newHome).append(id, 1, end)).toMatchObject({ revision: 2 });
      expect(await actual.readdir(directory)).toEqual(['1.json', '2.json']);
    } finally { opened.mockRestore(); platform.mockRestore(); }
  });

  it('仅可穿越但不可读取的上级目录不会阻止向可写的 home 追加', async () => {
    const directory = await sessionDirectory();
    const inaccessible = path.dirname(home);
    const syncing: string[] = [];
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const platform = vi.mocked(os.platform).mockReturnValue('linux');
    const opened = vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (flags !== 'r') return actual.open(name, flags, mode);
      if (name === inaccessible) throw Object.assign(new Error('不可读取父目录'), { code: 'EACCES' });
      return {
        sync: async () => { syncing.push(String(name)); },
        close: async () => {},
      } as Awaited<ReturnType<typeof fs.open>>;
    });
    try {
      const warn = vi.fn();
      await expect(store.append(id, 0, begin, warn)).resolves.toMatchObject({ revision: 1 });
      expect(await store.load(id)).toMatchObject({ revision: 1 });
      expect(syncing).toContain(path.parse(home).root);
      expect(syncing.at(-1)).toBe(directory);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('祖先目录'));
      expect(warn.mock.calls[0]?.[0]).not.toContain(inaccessible);
    } finally { opened.mockRestore(); platform.mockRestore(); }
  });

  it('Windows 不尝试同步目录，仍可继续追加已提交修订', async () => {
    const platform = vi.mocked(os.platform).mockReturnValue('win32');
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const opened = vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (flags === 'r') throw Object.assign(new Error('Windows 不支持目录 fsync'), { code: 'EPERM' });
      return actual.open(name, flags, mode);
    });
    try {
      expect(await completeChat()).toMatchObject({ revision: 2 });
      expect(await store.load(id)).toMatchObject({ revision: 2 });
      expect(opened.mock.calls.some(([, flags]) => flags === 'r')).toBe(false);
    } finally { opened.mockRestore(); platform.mockRestore(); }
  });

  it('两个存储实例并发提交同一版本时仅一方成功', async () => {
    await store.append(id, 0, begin);
    const results = await Promise.allSettled([
      store.append(id, 1, end),
      new SessionStore(project, home).append(id, 1, { ...end, reply: '另一个回复' }),
    ]);
    const [winner] = results.filter(result => result.status === 'fulfilled');
    const [loser] = results.filter(result => result.status === 'rejected');
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(loser?.reason).toMatchObject({ code: 'conflict' });
    expect(await store.load(id)).toEqual(winner?.value);
    expect((await readdir(await sessionDirectory())).sort()).toEqual(['1.json', '2.json']);
  });

  it('相同 ID 的会话按规范化项目隔离', async () => {
    await completeChat();
    const anotherProject = path.join(home, 'another');
    await mkdir(anotherProject);
    const other = new SessionStore(anotherProject, home);
    expect(await other.list()).toEqual([]);
    expect(await other.load(id)).toBeNull();
    await other.append(id, 0, { ...begin, input: '其他项目' });
    expect((await store.load(id))?.revision).toBe(2);
    expect((await other.load(id))?.entries).toMatchObject([{ input: '其他项目' }]);
  });

  it('恢复可开始下一操作，旧的未完成开始可见但不能补写结束', async () => {
    await store.append(id, 0, begin);
    const restored = new SessionStore(project, home);
    expect(await restored.load(id)).toMatchObject({ unfinishedBegins: [1], history: [], readonly: false });
    await restored.append(id, 1, { ...begin, input: '新聊天' });
    await expect(store.append(id, 1, end)).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.append(id, 2, end)).rejects.toMatchObject({ code: 'invalid-entry' });
    const result = await restored.append(id, 2, { ...end, begin: 2 });
    expect(result.unfinishedBegins).toEqual([1]);
    expect(result.history).toEqual([{ role: 'user', content: '新聊天' }, { role: 'assistant', content: '模型回复' }]);
  });

  it('不将暂存文件当作已提交修订，也不清理其他写者的暂存文件', async () => {
    const directory = await sessionDirectory();
    await mkdir(directory, { recursive: true });
    const staging = path.join(directory, `${randomUUID()}.tmp`);
    await writeFile(staging, '{');
    const warning = expect.stringContaining('暂存文件');
    expect(await store.load(id)).toMatchObject({ revision: 0, entries: [], readonly: false, diagnostics: [warning] });
    expect(await store.list()).toMatchObject([{ id, revision: 0, readonly: false, diagnostics: [warning] }]);
    expect(await completeChat()).toMatchObject({ revision: 2, readonly: false, diagnostics: [warning] });
    expect(await readFile(staging, 'utf8')).toBe('{');
  });

  it.each([
    ['部分 JSON', '3.json', () => '{'],
    ['版本缺口', '4.json', () => '{}'],
    ['未知格式版本', '3.json', (record: object) => JSON.stringify({ ...record, version: 2 })],
    ['错误项目键', '3.json', (record: object) => JSON.stringify({ ...record, projectKey: '0'.repeat(64) })],
    ['错误会话 ID', '3.json', (record: object) => JSON.stringify({ ...record, id: randomUUID() })],
    ['错误修订号', '3.json', (record: object) => JSON.stringify({ ...record, revision: 2 })],
    ['非法日期', '3.json', (record: object) => JSON.stringify({ ...record, time: '2026-02-30T00:00:00.000Z' })],
    ['重复结束', '3.json', (record: object) => JSON.stringify({ ...record, entry: end })],
  ] as const)('损坏尾部（%s）保留可读前缀并拒绝追加', async (_label, filename, contents) => {
    const valid = await completeChat();
    const directory = await sessionDirectory();
    const first = JSON.parse(await readFile(path.join(directory, '1.json'), 'utf8'));
    await writeFile(path.join(directory, filename), contents({ ...first, revision: 3 }));
    const loaded = await store.load(id);
    expect(loaded).toMatchObject({ revision: 2, entries: valid.entries, history: valid.history, readonly: true });
    expect(loaded?.diagnostics.length).toBeGreaterThan(0);
    expect(await store.list()).toMatchObject([{ id, readonly: true, diagnostics: loaded?.diagnostics }]);
    await expect(store.append(id, 2, begin)).rejects.toMatchObject({ code: 'readonly' });
  });

  it.each([
    ['重复版本字段', (record: string) => record.replace('"version":1', '"version":2,"version":1')],
    ['转义后的重复回复字段', (record: string) => record.replace('"reply":', '"re\\u0070ly":"被覆盖", "reply":')],
    ['单个转义键', (record: string) => record.replace('"version":', '"versi\\u006fn":')],
    ['外部空白', (record: string) => `${record}\n`],
    ['UTF-8 BOM', (record: string) => `﻿${record}`],
  ] as const)('拒绝非规范记录（%s），不采用解析时被覆盖的字段', async (_label, mutate) => {
    await completeChat();
    const filename = path.join(await sessionDirectory(), '2.json');
    const original = await readFile(filename, 'utf8');
    const modified = mutate(original);
    expect(modified).not.toBe(original);
    await writeFile(filename, modified);
    expect(await store.load(id)).toMatchObject({ revision: 1, readonly: true, unfinishedBegins: [1], history: [] });
    await expect(store.append(id, 1, end)).rejects.toMatchObject({ code: 'readonly' });
  });

  it('项目别名改指向后，原实例只结束原项目的同 ID 会话', async () => {
    const alias = path.join(home, 'alias');
    const otherProject = path.join(home, 'other');
    await mkdir(otherProject);
    await symlink(project, alias, 'junction');
    const viaAlias = new SessionStore(alias, home);
    const other = new SessionStore(otherProject, home);
    await viaAlias.append(id, 0, { ...begin, input: '项目甲' });
    await other.append(id, 0, { ...begin, input: '项目乙' });
    await unlink(alias);
    await symlink(otherProject, alias, 'junction');

    await viaAlias.append(id, 1, end);
    expect(await store.load(id)).toMatchObject({ history: [{ role: 'user', content: '项目甲' }, { role: 'assistant', content: end.reply }] });
    expect(await other.load(id)).toMatchObject({ revision: 1, unfinishedBegins: [1], history: [] });
    expect(await viaAlias.list()).toMatchObject([{ id, preview: '项目甲' }]);
    expect(await new SessionStore(alias, home).load(id)).toMatchObject({ revision: 1, entries: [{ input: '项目乙' }] });
  });

  it('并发首次定位失败后，同一实例可以重试', async () => {
    const missing = path.join(home, 'missing');
    const retrying = new SessionStore(missing, home);
    const results = await Promise.allSettled([retrying.load(id), retrying.list()]);
    expect(results).toMatchObject([
      { status: 'rejected', reason: { code: 'ENOENT' } },
      { status: 'rejected', reason: { code: 'ENOENT' } },
    ]);
    if (results[0]?.status === 'rejected' && results[1]?.status === 'rejected') {
      expect(results[0].reason).toBe(results[1].reason);
    }
    await mkdir(missing);
    expect(await retrying.append(id, 0, begin)).toMatchObject({ revision: 1 });
  });

  it('首条修订损坏时仍可发现会话，不把它视作空会话', async () => {
    await store.append(id, 0, begin);
    await writeFile(path.join(await sessionDirectory(), '1.json'), Buffer.from([0xff]));
    expect(await store.load(id)).toMatchObject({ revision: 0, readonly: true, createdAt: null });
    expect(await store.list()).toMatchObject([{ id, revision: 0, readonly: true }]);
    await expect(store.append(id, 0, begin)).rejects.toMatchObject({ code: 'readonly' });
  });

  it('仅截断超限界面输出，按 UTF-8 字节限制且不破坏字符', async () => {
    const reply = '中🙂'.repeat(20_000);
    const limit = 64 * 1024;
    const marker = '\n[输出已截断]';
    const output = 'a'.repeat(limit - Buffer.byteLength(marker) - 1) + '🙂' + reply;
    await store.append(id, 0, begin);
    await store.append(id, 1, { ...end, output, reply });
    const result = await store.load(id);
    expect(result?.entries[1]).toMatchObject({ output: 'a'.repeat(limit - Buffer.byteLength(marker) - 1) + marker, reply });
    expect(result?.history[1]?.content).toBe(reply);

    const exactLimit = '🙂'.repeat(limit / 4);
    await store.append(id, 2, { kind: 'begin', operation: 'slash', input: '/run' });
    const exact = await store.append(id, 3, { kind: 'end', begin: 3, status: 'success', output: exactLimit });
    expect(exact.entries[3]).toMatchObject({ output: exactLimit });
  });

  it('列表按更新时间降序排列并展示规范化的限长单行预览', async () => {
    const second = randomUUID();
    await store.append(id, 0, { ...begin, input: '  第一\n\t条\u001b[31m ' + '🙂'.repeat(150) });
    await store.append(second, 0, { ...begin, input: '第二条' });
    // 明确设置不同的更新时间，不依赖磁盘操作的耗时或计时精度。
    const first = path.join(await sessionDirectory(), '1.json');
    const record = JSON.parse(await readFile(first, 'utf8'));
    await writeFile(first, JSON.stringify({ ...record, time: '2000-01-01T00:00:00.000Z' }));
    expect(await store.list()).toMatchObject([
      { id: second, preview: '第二条' },
      { id, preview: '第一 条 ' + '🙂'.repeat(114) + '…' },
    ]);
  });
});
