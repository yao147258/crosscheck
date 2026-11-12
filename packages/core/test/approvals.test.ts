import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Approvals, ArtifactStore, canonicalize, contentHash } from '../src/index';

describe('contentHash', () => {
  it('与键顺序无关', () => {
    expect(contentHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(contentHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  it('忽略 undefined 字段', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('数组顺序有意义', () => {
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });

  it('格式为 sha256:hex', () => {
    expect(contentHash('x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('Approvals', () => {
  const entry = { id: 'M09-AC-001', text: '原文' };

  it('未确认为 none，确认后为 approved', () => {
    const a = Approvals.empty();
    expect(a.state('clause', entry.id, entry)).toBe('none');
    a.approve('clause', entry.id, entry, 'alice', new Date('2026-11-12T00:00:00Z'));
    expect(a.state('clause', entry.id, entry)).toBe('approved');
    expect(a.record('clause', entry.id)).toMatchObject({ by: 'alice', at: '2026-11-12T00:00:00.000Z' });
  });

  it('内容修改后确认自动失效', () => {
    const a = Approvals.empty();
    a.approve('clause', entry.id, entry, 'alice');
    expect(a.state('clause', entry.id, { ...entry, text: '改过' })).toBe('stale');
  });

  it('不同种类互不影响', () => {
    const a = Approvals.empty();
    a.approve('clause', 'X', entry, 'alice');
    expect(a.state('case', 'X', entry)).toBe('none');
  });

  it('撤销确认', () => {
    const a = Approvals.empty();
    a.approve('case', 'T', entry, 'alice');
    a.revoke('case', 'T');
    expect(a.state('case', 'T', entry)).toBe('none');
  });

  it('可持久化到 approvals.json', async () => {
    const store = new ArtifactStore(await mkdtemp(path.join(tmpdir(), 'cc-appr-')));
    const a = Approvals.empty();
    a.approve('profile', 'auth.yaml', { roles: [] }, 'bob');
    await a.save(store);
    const b = await Approvals.load(store);
    expect(b.state('profile', 'auth.yaml', { roles: [] })).toBe('approved');
  });

  it('文件不存在时加载为空', async () => {
    const store = new ArtifactStore(await mkdtemp(path.join(tmpdir(), 'cc-appr-')));
    expect((await Approvals.load(store)).state('clause', 'x', {})).toBe('none');
  });
});
