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
  it('跳过忽略、凭证和链接，二进制文件同样登记', async () => {
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
  it('超大文件只登记不读取，不产生诊断', async () => {
    await writeFile(join(root, 'README.md'), Buffer.alloc(1024 * 1024 + 1));
    const result = await walkProject(root);
    expect(result.files).toEqual([{ path: 'README.md', bytes: 1024 * 1024 + 1 }]);
    expect(result.diagnostics).toEqual([]);
  });
  it('根目录不存在时报告诊断且不泄漏绝对路径', async () => {
    const missing = join(root, '不存在');
    const result = await walkProject(missing);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.join('\n')).not.toContain(missing);
  });
  it('对文件路径脱敏', async () => {
    const name = 'password=supersecret.md';
    await writeFile(join(root, name), 'token=privatevalue');
    const result = await walkProject(root);
    const output = JSON.stringify(result);
    expect(output).not.toContain('supersecret');
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
  it('除 .gitignore 外不读取任何文件内容', async () => {
    await writeFile(join(root, 'README.md'), '# 标题');
    await writeFile(join(root, 'package.json'), '{}');
    const original = filesModule.createProjectReader;
    const reads: string[] = [];
    const spy = vi.spyOn(filesModule, 'createProjectReader').mockImplementation((projectRoot) => {
      const reader = original(projectRoot);
      return { ...reader, readText: async (file, signal) => { reads.push(file); return reader.readText(file, signal); } };
    });
    try {
      const result = await walkProject(root);
      expect(result.files.map((f) => f.path).sort()).toEqual(['README.md', 'package.json']);
      expect(reads).toEqual(['.gitignore']);
    } finally { spy.mockRestore(); }
  });
  it('传播取消信号', async () => {
    const controller = new AbortController();
    controller.abort(new Error('取消遍历'));
    await expect(walkProject(root, { signal: controller.signal })).rejects.toThrow('取消遍历');
  });
});
