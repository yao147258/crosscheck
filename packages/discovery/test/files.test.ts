import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
