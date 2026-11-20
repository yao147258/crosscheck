import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOverview, keyFileRank, readReadmeHead, type FileEntry } from '../src/index';

const entries = (paths: string[]): FileEntry[] => paths.map((path) => ({ path, bytes: 1 }));

describe('keyFileRank', () => {
  it('README 优先于配置、入口与普通文档', () => {
    expect(keyFileRank('README.md')).toBe(0);
    expect(keyFileRank('web/apps/admin/package.json')).toBe(1);
    expect(keyFileRank('web/apps/admin/vite.config.ts')).toBe(1);
    expect(keyFileRank('server/src/main.ts')).toBe(2);
    expect(keyFileRank('doc/requirements/M01.md')).toBe(3);
    expect(keyFileRank('server/src/user/service.ts')).toBe(4);
  });
});

describe('buildOverview', () => {
  it('文件不超过 300 个时给出完整清单并脱敏', () => {
    const text = buildOverview(entries(['README.md', 'src/a.ts', 'token=abc/x.md']));
    expect(text).toContain('共 3 个文件');
    expect(text).toContain('src/a.ts');
    expect(text).not.toContain('abc');
  });
  it('文件较多时按目录聚合，关键文件按重要程度排列', () => {
    const paths = ['README.md', 'web/package.json', ...Array.from({ length: 200 }, (_, i) => `doc/r${i}.md`), ...Array.from({ length: 200 }, (_, i) => `web/apps/admin/src/views/v${i}.vue`)];
    const text = buildOverview(entries(paths));
    expect(text).toContain('共 402 个文件');
    expect(text).toContain('doc/ (200)');
    expect(text).toContain('  apps/ (200)');
    expect(text).not.toContain('v199.vue');
    const key = text.slice(text.indexOf('关键文件'));
    expect(key.indexOf('README.md')).toBeLessThan(key.indexOf('web/package.json'));
    expect(key.indexOf('web/package.json')).toBeLessThan(key.indexOf('doc/r0.md'));
  });
  it('超大目录树不超过 8000 字符', () => {
    const paths = Array.from({ length: 5000 }, (_, i) => `d${i % 900}/e${i % 7}/f${i % 5}/file${i}.ts`);
    expect(buildOverview(entries(paths)).length).toBeLessThanOrEqual(8000);
  });
});

describe('readReadmeHead', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
  it('读取根目录 README 前 60 行并脱敏，缺失或中断时返回 undefined', async () => {
    root = await mkdtemp(join(tmpdir(), 'overview-'));
    await writeFile(join(root, 'README.md'), ['# 标题', 'password=hunter2', ...Array.from({ length: 100 }, (_, i) => `行${i}`)].join('\n'));
    const files = entries(['README.md']);
    const head = await readReadmeHead(root, files);
    expect(head).toHaveLength(60);
    expect(head![0]).toBe('# 标题');
    expect(head!.join('\n')).not.toContain('hunter2');
    expect(await readReadmeHead(root, entries(['src/a.ts']))).toBeUndefined();
    expect(await readReadmeHead(root, files, AbortSignal.abort())).toBeUndefined();
  });
});
