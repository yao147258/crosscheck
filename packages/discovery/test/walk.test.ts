import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as filesModule from '../src/files';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGitignore, walkProject } from '../src/index';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'walk-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('有限 gitignore 匹配', () => {
  it('支持名称、目录、路径和根锚定模式', () => {
    const match = parseGitignore('# 注释\n!keep\nbuild/\n*.log\n/dist\na/cache\n', { caseSensitive: false });
    expect(match('x/build', true)).toBe(true);
    expect(match('x/build/a', false)).toBe(true);
    expect(match('build', false)).toBe(false);
    expect(match('x/a.log', false)).toBe(true);
    expect(match('X/BUILD', true)).toBe(true);
    expect(match('X/A.LOG', false)).toBe(true);
    expect(match('dist', true)).toBe(true);
    expect(match('x/dist', true)).toBe(false);
    expect(match('a/cache/file', false)).toBe(true);
  });
  it('支持区分大小写，并按平台选择默认策略', () => {
    const sensitive = parseGitignore('Build/\n*.LOG', { caseSensitive: true });
    expect(sensitive('build', true)).toBe(false);
    expect(sensitive('Build', true)).toBe(true);
    expect(sensitive('file.log', false)).toBe(false);
    const defaultMatch = parseGitignore('Build/');
    expect(defaultMatch('build', true)).toBe(process.platform === 'win32');
  });
});

describe('项目遍历', () => {
  it('跳过忽略、凭证和链接，二进制只登记，按优先级摘录', async () => {
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'node_modules/pkg/x'), 'x');
    await writeFile(join(root, '.gitignore'), '*.tmp\n');
    await writeFile(join(root, 'a.tmp'), 'x');
    await writeFile(join(root, '.env'), 'SECRET=1');
    await writeFile(join(root, 'GUIDE.md'), Buffer.from([35, 0, 10]));
    await writeFile(join(root, 'README.md'), '# 标题\n\n正文行');
    await writeFile(join(root, 'src/index.ts'), 'export {};');
    await symlink(root, join(root, 'loop'), 'junction');
    const result = await walkProject(root);
    expect(result.files.map((f) => f.path).sort()).toEqual(['.gitignore', 'GUIDE.md', 'README.md', 'src/index.ts']);
    expect(result.files.find((f) => f.path === 'README.md')?.excerpt).toEqual(['# 标题', '正文行']);
    expect(result.files.find((f) => f.path === 'GUIDE.md')?.excerpt).toBeUndefined();
    expect(result.files.find((f) => f.path === 'src/index.ts')?.excerpt).toEqual(['export {};']);
    expect(result.diagnostics).toEqual([]);
  });
  it('默认忽略目录按平台大小写规则匹配', async () => {
    for (const dir of ['NODE_MODULES', '.GIT', 'DIST']) {
      await mkdir(join(root, dir));
      await writeFile(join(root, dir, 'file.txt'), 'x');
    }
    const result = await walkProject(root);
    expect(result.files.map((file) => file.path).sort()).toEqual(process.platform === 'win32' ? [] : ['.GIT/file.txt', 'DIST/file.txt', 'NODE_MODULES/file.txt']);
  });
  it('按优先级严格执行每文件与总行数预算并报告截断', async () => {
    await writeFile(join(root, 'README.md'), Array.from({ length: 150 }, (_, i) => `行${i}`).join('\n'));
    await writeFile(join(root, 'docs.md'), Array.from({ length: 300 }, (_, i) => `文${i}`).join('\n'));
    const result = await walkProject(root, { excerptLinesPerFile: 100, excerptTotalLines: 120 });
    expect(result.files.find((f) => f.path === 'README.md')).toMatchObject({ excerpt: expect.arrayContaining(['行0', '行99']), truncated: true });
    expect(result.files.find((f) => f.path === 'README.md')?.excerpt).toHaveLength(100);
    expect(result.files.find((f) => f.path === 'docs.md')?.excerpt).toHaveLength(20);
    expect(result.files.find((f) => f.path === 'docs.md')?.truncated).toBe(true);
    expect(result.diagnostics.join('\n')).toContain('截断');
  });
  it('多个近 1 MiB 单行文件受逐行、单文件及累计 UTF-8 字节预算限制', async () => {
    const line = '界'.repeat(349525);
    for (const name of ['README.md', 'a.md', 'b.md']) await writeFile(join(root, name), line);
    const result = await walkProject(root, { excerptBytesPerLine: 1024, excerptBytesPerFile: 900, excerptTotalBytes: 1500 });
    const excerpts = result.files.flatMap((file) => file.excerpt ?? []);
    expect(excerpts.reduce((sum, text) => sum + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(1500);
    expect(excerpts.every((text) => Buffer.byteLength(text) <= 900 && !text.includes('�'))).toBe(true);
    expect(result.files.find((file) => file.path === 'README.md')?.truncated).toBe(true);
    expect(result.diagnostics.join('\n')).toContain('字节');
  });
  it('摘录前整体脱敏 YAML 多行秘密', async () => {
    await writeFile(join(root, 'README.md'), 'password: |\n  super-secret-first\n  super-secret-second\npublic: value');
    const result = await walkProject(root);
    const excerpt = JSON.stringify(result.files[0]?.excerpt);
    expect(excerpt).not.toContain('super-secret-first');
    expect(excerpt).not.toContain('super-secret-second');
    expect(excerpt).toContain('public: value');
  });
  it('逐行和单文件字节预算独立生效', async () => {
    await writeFile(join(root, 'README.md'), '界'.repeat(10) + '\n' + '界'.repeat(10));
    const result = await walkProject(root, { excerptBytesPerLine: 10, excerptBytesPerFile: 15, excerptTotalBytes: 100 });
    expect(result.files[0]?.excerpt).toEqual(['界界界', '界界']);
    expect(result.files[0]?.truncated).toBe(true);
    expect(result.diagnostics.join('\n')).toContain('字节');
  });
  it.each(['lines', 'bytes'])('总%s预算耗尽后仅对实际遗漏的文本候选标记截断', async (kind) => {
    await writeFile(join(root, 'README.md'), 'first');
    await writeFile(join(root, 'a.md'), 'omitted');
    await writeFile(join(root, 'b.md'), '');
    await writeFile(join(root, 'c.md'), Buffer.from([0, 1]));
    const result = await walkProject(root, kind === 'lines' ? { excerptTotalLines: 1 } : { excerptTotalBytes: 5 });
    expect(result.files.find((file) => file.path === 'README.md')?.truncated).toBeUndefined();
    expect(result.files.find((file) => file.path === 'a.md')?.truncated).toBe(true);
    expect(result.files.find((file) => file.path === 'b.md')?.truncated).toBeUndefined();
    expect(result.files.find((file) => file.path === 'c.md')?.truncated).toBeUndefined();
  });
  it('超过文件上限记录诊断，恰好上限不误报', async () => {
    for (let i = 0; i < 4; i++) await writeFile(join(root, `f${i}.txt`), 'x');
    expect((await walkProject(root, { maxFiles: 4 })).diagnostics).toEqual([]);
    const result = await walkProject(root, { maxFiles: 3 });
    expect(result.files).toHaveLength(3);
    expect(result.diagnostics.join('\n')).toContain('上限');
  });
  it('宽目录条目预算到达时停止登记并记录诊断', async () => {
    for (let i = 0; i < 5; i++) await mkdir(join(root, `dir${i}`));
    const result = await walkProject(root, { maxEntries: 3 });
    expect(result.diagnostics.join('\n')).toContain('条目');
    expect(result.diagnostics.join('\n')).toContain('上限');
    expect(result.diagnostics.join('\n')).toContain('关键文件');
    expect(result.diagnostics.join('\n')).toContain('顺序');
  });
  it('纯目录树受目录数量预算限制并记录诊断', async () => {
    await mkdir(join(root, 'a/b/c'), { recursive: true });
    const result = await walkProject(root, { maxDirectories: 2 });
    expect(result.diagnostics.join('\n')).toContain('目录');
    expect(result.diagnostics.join('\n')).toContain('上限');
  });
  it('超过目录深度上限时停止进入子目录并报告不完整', async () => {
    await mkdir(join(root, 'a/b/c'), { recursive: true });
    await writeFile(join(root, 'a/b/visible.txt'), 'x');
    await writeFile(join(root, 'a/b/c/hidden.txt'), 'x');
    const result = await walkProject(root, { maxDepth: 2 });
    expect(result.files.map((f) => f.path)).toEqual(['a/b/visible.txt']);
    expect(result.diagnostics.join('\n')).toContain('深度');
    expect(result.diagnostics.join('\n')).toContain('a/b/c');
  });
  it('已入队目录消失时报告不完整并保留其他文件', async () => {
    await mkdir(join(root, 'vanished'));
    await writeFile(join(root, 'keep.txt'), 'x');
    const original = filesModule.createProjectReader;
    const spy = vi.spyOn(filesModule, 'createProjectReader').mockImplementation((projectRoot) => {
      const reader = original(projectRoot);
      return { ...reader, list: async (dir, signal, options) => {
        if (dir === 'vanished') await rm(join(root, 'vanished'), { recursive: true });
        return reader.list(dir, signal, options);
      } };
    });
    try {
      const result = await walkProject(root);
      expect(result.files.map((f) => f.path)).toEqual(['keep.txt']);
      expect(result.diagnostics.join('\n')).toContain('vanished');
      expect(result.diagnostics.join('\n')).toContain('不存在');
    } finally { spy.mockRestore(); }
  });
  it('超大候选文件记录诊断且保留清单', async () => {
    await writeFile(join(root, 'README.md'), Buffer.alloc(1024 * 1024 + 1));
    const result = await walkProject(root);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.excerpt).toBeUndefined();
    expect(result.diagnostics.join('\n')).toContain('README.md');
  });
  it('根目录不存在时报告诊断且不泄漏绝对路径', async () => {
    const missing = join(root, '不存在');
    const result = await walkProject(missing);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.join('\n')).not.toContain(missing);
  });
  it('对文件路径、摘录和诊断脱敏', async () => {
    const name = 'password=supersecret.md';
    await writeFile(join(root, name), 'token=privatevalue');
    await writeFile(join(root, 'README.md'), 'password=privatevalue\n第二行');
    const result = await walkProject(root, { excerptLinesPerFile: 1 });
    const output = JSON.stringify(result);
    expect(output).not.toContain('supersecret');
    expect(output).not.toContain('privatevalue');
    expect(output).toContain('[已隐藏]');
  });
  it('遍历过程中的目录读取错误产生诊断且不泄漏错误内容', async () => {
    const original = filesModule.createProjectReader;
    const spy = vi.spyOn(filesModule, 'createProjectReader').mockImplementation((projectRoot) => {
      const reader = original(projectRoot);
      return { ...reader, list: async (dir, signal) => {
        if (dir === 'blocked') throw new Error('password=secret');
        return reader.list(dir, signal);
      } };
    });
    try {
      await mkdir(join(root, 'blocked'));
      const result = await walkProject(root);
      expect(result.diagnostics.join('\n')).toContain('blocked');
      expect(result.diagnostics.join('\n')).not.toContain('secret');
    } finally { spy.mockRestore(); }
  });
  it('摘录读取期间取消必须传播而不是转换为诊断', async () => {
    const controller = new AbortController();
    const original = filesModule.createProjectReader;
    const spy = vi.spyOn(filesModule, 'createProjectReader').mockImplementation((projectRoot) => {
      const reader = original(projectRoot);
      return { ...reader, readText: async (file, signal) => {
        if (file === 'README.md') controller.abort(new Error('中途取消'));
        return reader.readText(file, signal);
      } };
    });
    try {
      await writeFile(join(root, 'README.md'), '内容');
      await expect(walkProject(root, { signal: controller.signal })).rejects.toThrow('中途取消');
    } finally { spy.mockRestore(); }
  });
  it('传播取消信号', async () => {
    const controller = new AbortController();
    controller.abort(new Error('取消遍历'));
    await expect(walkProject(root, { signal: controller.signal })).rejects.toThrow('取消遍历');
  });
});
