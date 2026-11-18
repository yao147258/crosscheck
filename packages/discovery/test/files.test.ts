import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, lstat: vi.fn(original.lstat) };
});
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectReader } from '../src/index';

let root: string;
let outside: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'discovery-root-'));
  outside = await mkdtemp(join(tmpdir(), 'discovery-outside-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('目录枚举', () => {
  it('列出直接子项并对缺失目录返回空', async () => {
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'a.txt'), '12345');
    const reader = createProjectReader(root);
    expect(await reader.list('sub')).toEqual([{ name: 'a.txt', type: 'file', size: 5 }]);
    expect(await reader.list('missing')).toEqual([]);
  });
  it('保留路径安全边界并标记符号链接', async () => {
    await mkdir(join(root, '.env.dir'));
    await symlink(outside, join(root, 'link'), 'junction');
    const reader = createProjectReader(root);
    for (const dir of ['../', '.env.dir', 'link', 'CON']) await expect(reader.list(dir)).rejects.toThrow();
    expect((await reader.list('')).find((entry) => entry.name === 'link')).toMatchObject({ link: true });
  });
  it('条目元数据读取失败时保留其他条目并报告安全诊断', async () => {
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, 'b.txt'), 'b');
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const spy = vi.mocked(fs.lstat);
    spy.mockImplementation(((file: Parameters<typeof fs.lstat>[0], options?: unknown) => {
      if (String(file).replaceAll('\\', '/').endsWith('/a.txt')) return Promise.reject(new Error('password=secret'));
      return (original.lstat as (input: Parameters<typeof fs.lstat>[0], options?: unknown) => ReturnType<typeof fs.lstat>)(file, options);
    }) as typeof fs.lstat);
    const diagnostics: string[] = [];
    try {
      const entries = await createProjectReader(root).list('', undefined, { onDiagnostic: (message) => diagnostics.push(message) });
      expect(entries.map((entry) => entry.name)).toEqual(['b.txt']);
      expect(diagnostics.length).toBe(1);
      expect(diagnostics.join('\n')).not.toContain('secret');
      expect(diagnostics.join('\n')).not.toContain(root);
    } finally { spy.mockImplementation(original.lstat); }
  });
  it('传播取消而不当作缺失目录', async () => {
    const controller = new AbortController();
    controller.abort(new Error('取消枚举'));
    await expect(createProjectReader(root).list('missing', controller.signal)).rejects.toThrow('取消枚举');
  });
});

describe('项目读取边界', () => {
  it('读取普通文件、规范化斜杠并跳过缺失文件', async () => {
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'dir', 'readme.md'), '项目');
    const reader = createProjectReader(root);
    expect(await reader.readText('dir\\readme.md')).toBe('项目');
    expect(await reader.readText('missing.md')).toBeUndefined();
  });
  it('拒绝绝对路径、父路径和凭证，但允许示例文件', async () => {
    await writeFile(join(root, '.env.example'), 'PORT=3000');
    const reader = createProjectReader(root);
    for (const file of ['../secret', 'a/../secret', '/secret', 'C:\\secret', '.env', '.env.local', 'dir/.env.production', '.env.example.local', 'id_rsa', 'credentials.json', '.npmrc']) {
      await expect(reader.readText(file)).rejects.toThrow();
    }
    expect(await reader.readText('.env.example')).toBe('PORT=3000');
  });
  it('项目根目录不可读取时不泄漏系统错误或绝对路径', async () => {
    const secretRoot = join(root, '秘密目录');
    const error = await createProjectReader(secretRoot).readText('file').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('读取项目文件失败');
    expect((error as Error).message).not.toContain(secretRoot);
  });
  it('拒绝超大文件和目录', async () => {
    await writeFile(join(root, 'large'), Buffer.alloc(1024 * 1024 + 1));
    const reader = createProjectReader(root);
    await expect(reader.readText('large')).rejects.toThrow();
    await expect(reader.readText('.')).rejects.toThrow();
  });
  it('拒绝指向项目外的目录链接', async () => {
    await writeFile(join(outside, 'secret'), '保密');
    await symlink(outside, join(root, 'link'), 'junction');
    await expect(createProjectReader(root).readText('link/secret')).rejects.toThrow();
  });
  it('拒绝凭证目录、秘密文件和 Windows 设备路径', async () => {
    const reader = createProjectReader(root);
    for (const file of ['.ssh/config', 'secrets.json', 'token.txt', 'README.md:secret', 'CON', 'NUL.txt', '.env.', '.env ', 'dir./file']) {
      await expect(reader.readText(file)).rejects.toThrow();
    }
  });
  it('即使链接指向项目内部也拒绝读取', async () => {
    await mkdir(join(root, 'target'));
    await writeFile(join(root, 'target', 'file'), '内容');
    await symlink(join(root, 'target'), join(root, 'internal-link'), 'junction');
    await expect(createProjectReader(root).readText('internal-link/file')).rejects.toThrow();
  });
  it('允许恰好 1 MiB 的普通文件', async () => {
    await writeFile(join(root, 'limit'), Buffer.alloc(1024 * 1024, 'a'));
    expect((await createProjectReader(root).readText('limit'))?.length).toBe(1024 * 1024);
  });
  it('在文件缺失前传播已取消信号', async () => {
    const controller = new AbortController();
    controller.abort(new Error('取消读取'));
    await expect(createProjectReader(root).readText('missing', controller.signal)).rejects.toThrow('取消读取');
  });
});
