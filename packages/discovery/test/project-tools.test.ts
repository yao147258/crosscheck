import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetTracker } from '@crosscheck/core';
import { withProgress } from '@crosscheck/models';
import { BUDGET_NOTICE, createProjectTools, walkProject, type FileEntry } from '../src/index';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-tools-'));
  await mkdir(join(root, 'src/routes'), { recursive: true });
  await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# 演示\n启动：pnpm dev\n');
  await writeFile(join(root, 'package.json'), '{\n  "scripts": { "dev": "vite --port 5173" }\n}\n');
  await writeFile(join(root, 'src/app.ts'), "const app = express();\napp.get('/health', handler);\nAPP.GET('/upper', handler);\n");
  await writeFile(join(root, 'src/routes/users.ts'), "router.get('/users', list);\n");
  await writeFile(join(root, 'config.yaml'), 'password: |\n  hunter2\npublic: fixture-key\n');
  await writeFile(join(root, 'long.txt'), Array.from({ length: 300 }, (_, i) => `${i}`.padEnd(100, 'x')).join('\n'));
  await writeFile(join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
  await writeFile(join(root, '.env'), 'SECRET=1');
  await writeFile(join(root, 'node_modules/pkg/index.js'), 'x');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const ctx = { signal: new AbortController().signal };
async function tools(options: { budget?: BudgetTracker; files?: FileEntry[]; clean?: (text: string) => string } = {}) {
  const files = options.files ?? (await walkProject(root)).files;
  const budget = options.budget ?? new BudgetTracker({ steps: 50, tokens: 100000, minutes: 5 });
  return Object.fromEntries(createProjectTools({ projectRoot: root, files, budget, clean: options.clean }).map((tool) => [tool.name, tool]));
}
const run = async (name: string, input: unknown, options?: Parameters<typeof tools>[0]) => {
  const tool = (await tools(options))[name]!;
  return tool.execute(tool.input.parse(input), ctx) as Promise<any>;
};

describe('list_dir', () => {
  it('根目录列出登记的文件与子目录文件数，不含凭证与忽略目录', async () => {
    const result = await run('list_dir', {});
    const names = result.entries.map((entry: { name: string }) => entry.name);
    expect(names).toContain('README.md');
    expect(result.entries).toContainEqual({ name: 'src', type: 'dir', files: 2 });
    expect(names).not.toContain('.env');
    expect(names).not.toContain('node_modules');
  });
  it('支持子目录与 . 表示根目录，未知目录报错', async () => {
    expect((await run('list_dir', { path: 'src' })).entries).toContainEqual({ name: 'routes', type: 'dir', files: 1 });
    expect((await run('list_dir', { path: '.' })).entries.length).toBeGreaterThan(0);
    await expect(run('list_dir', { path: 'node_modules' })).rejects.toThrow('目录');
  });
});

describe('read_file', () => {
  it('返回带行号的内容与总行数，支持分段读取', async () => {
    const all = await run('read_file', { path: 'src/app.ts' });
    expect(all.content).toBe("1: const app = express();\n2: app.get('/health', handler);\n3: APP.GET('/upper', handler);\n4: ");
    expect(all.totalLines).toBe(4);
    const part = await run('read_file', { path: 'src/app.ts', startLine: 2, lineCount: 1 });
    expect(part).toMatchObject({ startLine: 2, endLine: 2, content: "2: app.get('/health', handler);" });
    expect(part.more).toContain('startLine=3');
  });
  it('拒绝清单外、凭证、忽略目录与越界路径，拒绝二进制', async () => {
    for (const path of ['.env', 'node_modules/pkg/index.js', '../outside.txt', 'missing.ts']) {
      await expect(run('read_file', { path })).rejects.toThrow('清单');
    }
    await expect(run('read_file', { path: 'bin.dat' })).rejects.toThrow('二进制');
  });
  it('多行秘密脱敏并应用调用方清理', async () => {
    const result = await run('read_file', { path: 'config.yaml' }, { clean: (text) => text.replaceAll('fixture-key', '[密钥]') });
    expect(result.content).not.toContain('hunter2');
    expect(result.content).not.toContain('fixture-key');
    expect(result.content).toContain('[密钥]');
    expect(result.totalLines).toBe(4);
  });
  it('单次不超过字节上限并提示继续读取', async () => {
    const result = await run('read_file', { path: 'long.txt' });
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(16384);
    expect(result.endLine).toBeLessThan(200);
    expect(result.more).toContain(`startLine=${result.endLine + 1}`);
  });
});

describe('grep', () => {
  it('不区分大小写的文本匹配，返回 文件:行号: 原文', async () => {
    const result = await run('grep', { pattern: "app.get('" });
    expect(result.matches).toEqual(["src/app.ts:2: app.get('/health', handler);", "src/app.ts:3: APP.GET('/upper', handler);"]);
  });
  it('按目录与 glob 过滤，模式不按正则解释', async () => {
    expect((await run('grep', { pattern: '.get(', path: 'src/routes' })).matches).toEqual(["src/routes/users.ts:1: router.get('/users', list);"]);
    expect((await run('grep', { pattern: 'get(', glob: 'users.*' })).matches).toHaveLength(1);
    expect((await run('grep', { pattern: '.*' })).matches).toEqual([]);
  });
  it('结果超过上限时截断并提示', async () => {
    await writeFile(join(root, 'many.txt'), Array.from({ length: 150 }, () => 'needle').join('\n'));
    const result = await run('grep', { pattern: 'needle' });
    expect(result.matches).toHaveLength(100);
    expect(result.truncated).toContain('100');
  });
});

describe('收尾提醒与进度', () => {
  it('额度充足时不提醒，剩余步数不超过 5 时提醒', async () => {
    expect((await run('list_dir', {})).notice).toBeUndefined();
    const budget = new BudgetTracker({ steps: 6, tokens: 100000, minutes: 5 });
    budget.recordStep();
    expect((await run('list_dir', {}, { budget })).notice).toBe(BUDGET_NOTICE);
  });
  it('工具执行时上报进度', async () => {
    const lines: string[] = [];
    await withProgress((line) => lines.push(line), () => run('read_file', { path: 'src/app.ts' }));
    expect(lines).toContain('读取 src/app.ts');
  });
});
