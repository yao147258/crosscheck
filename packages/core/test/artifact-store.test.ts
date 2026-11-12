import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactError, ArtifactStore, type Clause } from '../src/index';

let dir: string;
let store: ArtifactStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cc-store-'));
  store = new ArtifactStore(dir);
});

const clause: Clause = {
  id: 'M09-AC-001',
  text: '条款',
  source: { file: 'a.md', line: 1, excerpt: '原文' },
  status: 'active',
  notes: '',
};

describe('ArtifactStore', () => {
  it('根目录是 .crosscheck', () => {
    expect(store.root).toBe(path.join(dir, '.crosscheck'));
  });

  it('条款可往返读写，文件为 YAML', async () => {
    await store.saveClauses('M09', [clause]);
    expect(await store.loadClauses('M09')).toEqual([clause]);
    const raw = await readFile(path.join(dir, '.crosscheck/requirements/M09.yaml'), 'utf8');
    expect(raw).toContain('id: M09-AC-001');
  });

  it('不存在的模块返回空数组', async () => {
    expect(await store.loadCases('NOPE')).toEqual([]);
  });

  it('拒绝逃逸出 .crosscheck 的路径', () => {
    expect(() => store.resolve('../src/app.ts')).toThrow(ArtifactError);
  });

  it('拒绝非法模块名', async () => {
    await expect(store.saveClauses('../x', [clause])).rejects.toThrow(ArtifactError);
  });

  it('内容不合 schema 时报错并带文件路径', async () => {
    await mkdir(path.join(dir, '.crosscheck/requirements'), { recursive: true });
    await writeFile(path.join(dir, '.crosscheck/requirements/M01.yaml'), '- id: bad\n', 'utf8');
    await expect(store.loadClauses('M01')).rejects.toThrow(/requirements[\\/]M01\.yaml/);
  });

  it('列出模块', async () => {
    await store.saveClauses('M09', [clause]);
    await store.saveClauses('M01', []);
    expect(await store.listModules('requirements')).toEqual(['M01', 'M09']);
    expect(await store.listModules('cases')).toEqual([]);
  });

  it('缺少 config.yaml 时给出可读的错误', async () => {
    await expect(store.loadConfig()).rejects.toThrow(/crosscheck init/);
  });

  it('JSON 往返读写', async () => {
    const schema = (await import('zod')).z.object({ a: (await import('zod')).z.number() });
    await store.writeJson('x/y.json', { a: 1 });
    expect(await store.readJson('x/y.json', schema)).toEqual({ a: 1 });
  });

  it('同一路径并发写入不冲突，最终内容是其中之一', async () => {
    const schema = (await import('zod')).z.object({ a: (await import('zod')).z.number() });
    await expect(
      Promise.all(Array.from({ length: 10 }, (_, i) => store.writeJson('x/concurrent.json', { a: i }))),
    ).resolves.toBeDefined();
    const result = await store.readJson('x/concurrent.json', schema);
    expect(result?.a).toBeGreaterThanOrEqual(0);
    expect(result?.a).toBeLessThan(10);
  });
});
