import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ArtifactStore, ArtifactError } from '../src/index';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});

describe('受控工件 IO', () => {
  it('二进制往返并对损坏的 JSON 和 YAML 使用带原因的安全错误', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-'));
    const store = new ArtifactStore(dir);
    await store.writeBytes('a/data', new Uint8Array([0, 255, 1]));
    expect([...((await store.readBytes('a/data'))!)]).toEqual([0, 255, 1]);
    for (const [name, body] of [['bad.json', '{"secret":'], ['bad.yaml', 'secret: [']] as const) {
      await writeFile(path.join(store.root, name), body);
      try {
        if (name.endsWith('json')) await store.readJson(name, z.object({}));
        else await store.readYaml(name, z.object({}));
        throw new Error('未拒绝损坏内容');
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactError);
        expect((error as Error).cause).toBeDefined();
        expect((error as Error).message).not.toContain('secret');
      }
    }
  });
  it('排他发布完整文件且目标已存在时不覆盖', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-'));
    const store = new ArtifactStore(dir);
    await store.publishExclusive('locks/run.json', Buffer.from('{"pid":123}'));
    expect((await store.readBytes('locks/run.json'))?.toString()).toBe('{"pid":123}');
    let error: unknown;
    try { await store.publishExclusive('locks/run.json', Buffer.from('overwrite')); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ArtifactError);
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('EEXIST');
    expect((await store.readBytes('locks/run.json'))?.toString()).toBe('{"pid":123}');
    expect((await readdir(path.join(store.root, 'locks'))).filter(x => x.endsWith('.tmp'))).toEqual([]);
  });
  it('硬链接发布前失败不产生目标，发布时目标内容已完整', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-'));
    const store = new ArtifactStore(dir);
    const original = fs.link;
    const spy = vi.spyOn(fs, 'link');
    try {
      spy.mockImplementationOnce(async (source, target) => {
        expect(await store.readBytes('locks/pre.json')).toBeUndefined();
        expect((await readFile(source)).toString()).toBe('{"pid":123}');
        throw Object.assign(new Error('模拟发布前崩溃'), { code: 'EIO' });
      });
      await expect(store.publishExclusive('locks/pre.json', Buffer.from('{"pid":123}'))).rejects.toBeInstanceOf(ArtifactError);
      expect(await store.readBytes('locks/pre.json')).toBeUndefined();
      spy.mockImplementationOnce(async (source, target) => {
        expect(await store.readBytes('locks/post.json')).toBeUndefined();
        await original(source, target);
        expect((await store.readBytes('locks/post.json'))?.toString()).toBe('{"pid":123}');
        throw Object.assign(new Error('模拟发布后崩溃'), { code: 'EIO' });
      });
      await expect(store.publishExclusive('locks/post.json', Buffer.from('{"pid":123}'))).rejects.toBeInstanceOf(ArtifactError);
      expect((await store.readBytes('locks/post.json'))?.toString()).toBe('{"pid":123}');
      expect((await readdir(path.join(store.root, 'locks'))).filter(x => x.endsWith('.tmp'))).toEqual([]);
    } finally { spy.mockRestore(); }
  });
  it('根目录链接不能绕过物理边界', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'outside-'));
    const store = new ArtifactStore(dir);
    await symlink(outside, store.root, 'junction');
    await expect(store.writeBytes('escape', Buffer.from('x'))).rejects.toBeInstanceOf(ArtifactError);
    expect(await readdir(outside)).toEqual([]);
  });
  it('拒绝指向外部目录的链接，且失败写入清理临时文件', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'outside-'));
    const store = new ArtifactStore(dir);
    await mkdir(store.root);
    await symlink(outside, path.join(store.root, 'link'), 'junction');
    await expect(store.writeBytes('link/escape', new Uint8Array([1]))).rejects.toBeInstanceOf(ArtifactError);
    expect(await readdir(outside)).toEqual([]);
    await mkdir(path.join(store.root, 'target'));
    await expect(store.writeBytes('target', new Uint8Array([1]))).rejects.toBeInstanceOf(ArtifactError);
    expect((await readdir(store.root)).filter(x => x.endsWith('.tmp'))).toEqual([]);
    await expect(readFile(path.join(outside, 'escape'))).rejects.toThrow();
  });
});
