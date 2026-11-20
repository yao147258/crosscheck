import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiskDocLister, createProjectReader, expandRequirementDocs, parseDocEntry } from '../src/index';

let root: string;
let outside: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reqdocs-root-'));
  outside = await mkdtemp(join(tmpdir(), 'reqdocs-outside-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
async function put(file: string, text = '内容') {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}
const expand = (entries: string[], options?: { allowEmpty?: boolean }, diagnostics: string[] = [], signal?: AbortSignal) =>
  expandRequirementDocs(entries, createDiskDocLister(createProjectReader(root), (m) => diagnostics.push(m)), signal, options);

describe('parseDocEntry', () => {
  it('统一分隔符并识别目录写法', () => {
    expect(parseDocEntry('docs\\prd\\')).toEqual({ path: 'docs/prd', directory: true });
    expect(parseDocEntry('./docs/a.md')).toEqual({ path: 'docs/a.md', directory: false });
  });
});

describe('expandRequirementDocs', () => {
  it('多层嵌套只收 .md（不区分大小写），结果排序', async () => {
    await put('docs/prd/b.md'); await put('docs/prd/a.md'); await put('docs/prd/sub/deep/c.MD');
    await put('docs/prd/img.png'); await put('docs/prd/notes.txt');
    expect(await expand(['docs/prd/'])).toEqual(['docs/prd/a.md', 'docs/prd/b.md', 'docs/prd/sub/deep/c.MD']);
  });
  it('反斜杠目录写法等价', async () => {
    await put('docs/prd/a.md');
    expect(await expand(['docs\\prd\\'])).toEqual(['docs/prd/a.md']);
  });
  it('跳过忽略目录、凭证与不安全名称', async () => {
    await put('docs/ok.md'); await put('docs/node_modules/x.md'); await put('docs/.git/y.md');
    await put('docs/.crosscheck/z.md'); await put('docs/.env.d/a.md'); await put('docs/secrets.md');
    expect(await expand(['docs/'])).toEqual(['docs/ok.md']);
  });
  it('跳过符号链接并给出诊断', async () => {
    await put('docs/ok.md');
    await writeFile(join(outside, 'leak.md'), '外部');
    await mkdir(join(root, 'docs'), { recursive: true });
    await symlink(outside, join(root, 'docs', 'link'), 'junction');
    const diagnostics: string[] = [];
    expect(await expand(['docs/'], undefined, diagnostics)).toEqual(['docs/ok.md']);
    expect(diagnostics.join('\n')).toContain('跳过符号链接');
  });
  it('深度 8 层子目录内的文件被收录，第 9 层被忽略', async () => {
    await put(`docs/${'d/'.repeat(8)}in.md`); await put(`docs/${'d/'.repeat(9)}out.md`);
    expect(await expand(['docs/'])).toEqual([`docs/${'d/'.repeat(8)}in.md`]);
  });
  it('文件总数超过 100 个报错而不是截断', async () => {
    await Promise.all(Array.from({ length: 101 }, (_, i) => put(`docs/f${i}.md`)));
    await expect(expand(['docs/'])).rejects.toThrow('100');
  });
  it('目录不存在或没有 .md 报错；allowEmpty 时返回空', async () => {
    await put('empty/readme.txt');
    await expect(expand(['missing/'])).rejects.toThrow('没有 .md');
    await expect(expand(['empty/'])).rejects.toThrow('没有 .md');
    expect(await expand(['missing/', 'empty/'], { allowEmpty: true })).toEqual([]);
  });
  it('项目根目录不允许作为需求文档目录', async () => {
    await expect(expand(['./'])).rejects.toThrow('根目录');
  });
  it('不安全的目录写法报错', async () => {
    await expect(expand(['../outside/'])).rejects.toThrow('不安全');
  });
  it('目录与显式文件混合时去重，显式文件不限扩展名', async () => {
    await put('docs/a.md'); await put('docs/b.txt');
    expect(await expand(['docs/', 'docs/a.md', 'docs\\a.md', 'docs/b.txt'])).toEqual(['docs/a.md', 'docs/b.txt']);
  });
  it('显式绝对文件路径原样保留，不被改写成项目相对路径', async () => {
    await put('docs/a.md');
    expect(await expand(['/docs/a.md'])).toEqual(['/docs/a.md']);
    expect(await expand(['docs/b.md', '/docs/a.md', 'docs/b.md', 'C:\\x\\a.md'])).toEqual(['/docs/a.md', 'C:\\x\\a.md', 'docs/b.md']);
  });
  it('绝对目录路径报不安全', async () => {
    await expect(expand(['/docs/'])).rejects.toThrow('不安全');
    await expect(expand(['C:\\docs\\'])).rejects.toThrow('不安全');
  });
  it('取消信号中止展开', async () => {
    await put('docs/a.md');
    const controller = new AbortController(); controller.abort();
    await expect(expand(['docs/'], undefined, [], controller.signal)).rejects.toThrow();
  });
  it('注入的列目录函数（如 Git）同样套用过滤、前缀与排序规则', async () => {
    const lister = async () => ['docs/b.md', 'docs/a.md', 'docs/x.png', 'other/y.md', 'docs/node_modules/z.md'];
    expect(await expandRequirementDocs(['docs/'], lister)).toEqual(['docs/a.md', 'docs/b.md']);
  });
});
