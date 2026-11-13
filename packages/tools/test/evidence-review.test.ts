import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../../core/src/index';
import { EvidenceStore, createEvidenceRedactor } from '../src/index';

const ctx = { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 };
const meta = { actionId: 'a-1', phase: 'execution' as const };
async function temporary(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-review-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function disk(root: string): Promise<string> {
  const walk = async (dir: string): Promise<string> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async e => e.isDirectory() ? walk(path.join(dir, e.name)) : (await readFile(path.join(dir, e.name))).toString()))).join('\n');
  return walk(path.join(root, '.crosscheck'));
}

describe('Task3 审查修复', () => {
  it('数据库对象及 JSON 字符串按字段脱敏后落盘', async () => temporary(async root => {
    const store = new EvidenceStore(new ArtifactStore(root), ctx, createEvidenceRedactor());
    const a = await store.saveJson('db', { password: 'unknown-db-secret', nested: { token: 'unknown-token' }, count: 3 }, meta);
    const b = await store.saveText('db', '{"password":"unknown-text-secret","count":4}', meta);
    expect(JSON.parse((await store.verify(a)).toString())).toEqual({ password: '[REDACTED]', nested: { token: '[REDACTED]' }, count: 3 });
    expect(JSON.parse((await store.verify(b)).toString())).toEqual({ password: '[REDACTED]', count: 4 });
    await expect(store.saveText('db', '{"password":"partial-secret"', meta)).rejects.toThrow();
    expect(await disk(root)).not.toMatch(/unknown-db-secret|unknown-token|unknown-text-secret|partial-secret/);
  }));
  it('无效 URL 不将未知敏感查询内容写入 HAR', async () => temporary(async root => {
    const store = new EvidenceStore(new ArtifactStore(root), ctx, createEvidenceRedactor());
    const record = await store.saveHar({ log: { entries: [{ request: { url: 'http://[invalid/?token=UNKNOWN-URL-SECRET' }, response: { redirectURL: 'http://[invalid/?password=OTHER-URL-SECRET', headers: [{ name: 'Location', value: 'http://[invalid/?sid=THIRD-URL-SECRET' }] } }] } }, meta);
    expect((await store.verify(record)).toString()).not.toMatch(/UNKNOWN-URL-SECRET|OTHER-URL-SECRET|THIRD-URL-SECRET/);
    expect(await disk(root)).not.toMatch(/UNKNOWN-URL-SECRET|OTHER-URL-SECRET|THIRD-URL-SECRET/);
  }));
  it('清理混合大小写百分号编码及空格加号组合', async () => temporary(async root => {
    const store = new EvidenceStore(new ArtifactStore(root), ctx, createEvidenceRedactor([], ['a/b c/d']));
    const record = await store.saveText('console', 'a%2fb+c%2Fd a%2Fb%20c%2fd', meta);
    const output = (await store.verify(record)).toString();
    expect(output).not.toMatch(/a%2fb\+c%2Fd|a%2Fb%20c%2fd/);
    expect(await disk(root)).not.toMatch(/a%2fb\+c%2Fd|a%2Fb%20c%2fd/);
  }));
  it('同目录不同 ArtifactStore 实例并发保存不丢索引，失败后队列继续', async () => temporary(async root => {
    class SlowStore extends ArtifactStore {
      override async readBytes(rel: string) {
        const value = await super.readBytes(rel);
        if (rel.endsWith('/evidence/index.json')) await new Promise(resolve => setTimeout(resolve, 30));
        return value;
      }
    }
    const a = new EvidenceStore(new SlowStore(root), ctx, createEvidenceRedactor());
    const b = new EvidenceStore(new SlowStore(root), ctx, createEvidenceRedactor());
    const records = await Promise.all([a.saveText('console', 'one', meta), b.saveText('console', 'two', meta)]);
    expect((await a.verify(records[0]!)).toString()).toBe('one');
    expect((await b.verify(records[1]!)).toString()).toBe('two');
    await expect(a.saveText('console', 'bad', { ...meta, actionId: '' })).rejects.toThrow();
    expect((await b.verify(await b.saveText('console', 'after', meta))).toString()).toBe('after');
  }));
  it('项目目录联接别名与真实路径共用写队列', async context => temporary(async root => {
    const real = path.join(root, 'project');
    const alias = path.join(root, 'alias');
    await mkdir(real);
    try { await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'ENOTSUP') { context.skip(`目录链接不可用: ${code}`); return; }
      throw error;
    }
    class SlowStore extends ArtifactStore {
      override async readBytes(rel: string) {
        const value = await super.readBytes(rel);
        if (rel.endsWith('/evidence/index.json')) await new Promise(resolve => setTimeout(resolve, 40));
        return value;
      }
    }
    const a = new EvidenceStore(new SlowStore(real), ctx, createEvidenceRedactor());
    const b = new EvidenceStore(new SlowStore(alias), ctx, createEvidenceRedactor());
    const [one, two] = await Promise.all([a.saveText('console', 'real', meta), b.saveText('console', 'alias', meta)]);
    expect((await a.verify(one)).toString()).toBe('real');
    expect((await b.verify(two)).toString()).toBe('alias');
  }));
  it('参数型 HAR 正文保留安全参数并遮蔽敏感参数', async () => temporary(async root => {
    const store = new EvidenceStore(new ArtifactStore(root), ctx, createEvidenceRedactor());
    const record = await store.saveHar({ log: { entries: [{ request: { postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'username', value: 'alice' }, { name: 'password', value: 'param-secret' }] } }, response: {} }] } }, meta);
    const output = JSON.parse((await store.verify(record)).toString());
    const post = output.log.entries[0].request.postData;
    expect(post.omitted).toBe(false);
    expect(post.params).toEqual([{ name: 'username', value: 'alice' }, { name: 'password', value: '[REDACTED]' }]);
    expect(await disk(root)).not.toContain('param-secret');
  }));
});
