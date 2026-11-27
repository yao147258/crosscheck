import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Approvals, ArtifactStore, ClauseSchema, DispositionSchema, TestCaseSchema,
  clauseDuplicateKey, compareArtifactIds, coverage, loadCoveredClauses, mergeDrafts, moduleOfId,
  partitionCases, partitionClauses, readProfileFile, readProfileFiles, resolveReviewer, upsertDisposition,
} from '../src/index';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
async function store() { const root = await mkdtemp(path.join(os.tmpdir(), 'p3core-')); roots.push(root); return new ArtifactStore(root); }

const clause = (id: string, text = `条款 ${id}`) => ClauseSchema.parse({ id, text, source: { file: 'a.md', line: 1, excerpt: '原' } });
const tc = (id: string, covers: string[]) => TestCaseSchema.parse({ id, covers, actor: 'guest', steps: ['步骤'], expectations: [{ id: 'E1', text: '预期', evidence: ['network'] }] });

describe('处置记录', () => {
  const base = { caseId: 'M-TC-1', expectationId: 'E1', by: '张三', at: '2026-11-16T00:00:00.000Z' };
  it('clause_issue 必须带 clauseId，其他决定不能带', () => {
    expect(DispositionSchema.safeParse({ ...base, decision: 'clause_issue' }).success).toBe(false);
    expect(DispositionSchema.safeParse({ ...base, decision: 'clause_issue', clauseId: 'M-AC-1' }).success).toBe(true);
    expect(DispositionSchema.safeParse({ ...base, decision: 'false_positive', clauseId: 'M-AC-1' }).success).toBe(false);
    expect(DispositionSchema.parse({ ...base, decision: 'confirmed_bug' }).note).toBe('');
  });
  it('同一用例与预期后写覆盖先写', () => {
    const file = { version: 1 as const, runId: 'r1', items: [DispositionSchema.parse({ ...base, decision: 'confirmed_bug' })] };
    const next = upsertDisposition(file, DispositionSchema.parse({ ...base, decision: 'false_positive' }));
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.decision).toBe('false_positive');
    expect(file.items[0]?.decision).toBe('confirmed_bug');
  });
});

describe('resolveReviewer', () => {
  it('优先使用 CROSSCHECK_REVIEWER', () => {
    expect(resolveReviewer({ CROSSCHECK_REVIEWER: '  李四 ' }, () => ({ username: 'os' }))).toBe('李四');
  });
  it('否则使用系统用户名', () => {
    expect(resolveReviewer({ CROSSCHECK_REVIEWER: '  ' }, () => ({ username: 'os-user' }))).toBe('os-user');
  });
  it('环境变量中的保留身份 auto 不回退到系统用户名', () => {
    expect(() => resolveReviewer({ CROSSCHECK_REVIEWER: ' auto ' }, () => ({ username: '人工' }))).toThrow(/auto.*保留/);
  });
  it('系统用户名为保留身份 auto 时拒绝', () => {
    expect(() => resolveReviewer({}, () => ({ username: 'auto' }))).toThrow(/auto.*保留/);
  });
  it('只保留精确同名，允许大小写不同的人工确认人', () => {
    expect(resolveReviewer({ CROSSCHECK_REVIEWER: 'Auto' })).toBe('Auto');
  });
  it('都拿不到时报错', () => {
    expect(() => resolveReviewer({}, () => { throw new Error('无'); })).toThrow(/CROSSCHECK_REVIEWER/);
  });
});

describe('moduleOfId', () => {
  it('从条款与用例 ID 推断模块', () => {
    expect(moduleOfId('M09-AC-003')).toBe('M09');
    expect(moduleOfId('shop_order-TC-12')).toBe('shop_order');
    expect(() => moduleOfId('bad')).toThrow();
  });
});

describe('readProfileFile', () => {
  it('区分缺失、不合法、合法，并返回带默认值的解析结果', async () => {
    const s = await store();
    expect(await readProfileFile(s, 'guardrails.yaml')).toEqual({ name: 'guardrails.yaml', present: false });
    await s.writeYaml('system/guardrails.yaml', { allowedHosts: [] });
    expect(await readProfileFile(s, 'guardrails.yaml')).toMatchObject({ present: true, ok: false });
    await s.writeYaml('system/guardrails.yaml', { allowedHosts: ['localhost:3000'] });
    expect(await readProfileFile(s, 'guardrails.yaml')).toEqual({ name: 'guardrails.yaml', present: true, ok: true, value: { allowedHosts: ['localhost:3000'], forbidden: [], redactFields: [] } });
    await s.writeBytes('system/pages.yaml', Buffer.from('a: [1,'));
    expect(await readProfileFile(s, 'pages.yaml')).toMatchObject({ present: true, ok: false, error: expect.stringContaining('YAML') });
    expect((await readProfileFiles(s)).map((f) => f.name)).toHaveLength(7);
  });
});

describe('mergeDrafts', () => {
  it('保留已确认条目，丢弃 ID 冲突与重复的草稿，按编号排序', () => {
    const approved = [clause('M-AC-2', '已确认')];
    const drafts = [clause('M-AC-10'), clause('M-AC-2', '冲突'), { ...clause('M-AC-3', '已确认') }, clause('M-AC-1')];
    const merged = mergeDrafts(approved, drafts, clauseDuplicateKey);
    expect(merged.items.map((c) => c.id)).toEqual(['M-AC-1', 'M-AC-2', 'M-AC-10']);
    expect(merged.items.find((c) => c.id === 'M-AC-2')?.text).toBe('已确认');
    expect(merged).toMatchObject({ kept: 1, added: 2 });
    expect(merged.dropped).toEqual([{ id: 'M-AC-2', reason: '与已确认条目 ID 冲突' }, { id: 'M-AC-3', reason: '与已确认条目内容重复' }]);
  });
  it('compareArtifactIds 按数字编号排序', () => {
    expect(['M-TC-10', 'M-TC-2'].map((id) => ({ id })).sort(compareArtifactIds).map((x) => x.id)).toEqual(['M-TC-2', 'M-TC-10']);
  });
});

describe('partition / coverage / loadCoveredClauses', () => {
  it('按确认状态拆分条款与用例', async () => {
    const a = Approvals.empty();
    const c1 = clause('M-AC-1'); const c2 = clause('M-AC-2');
    a.approve('clause', c1.id, c1, 'u');
    expect(partitionClauses([c1, c2], a)).toEqual({ approved: [c1], drafts: [c2] });
    const t1 = tc('M-TC-1', ['M-AC-1']); const t2 = tc('M-TC-2', ['M-AC-1']);
    a.approveCase(t1, [c1, c2], 'u');
    expect(partitionCases([t1, t2], [c1, c2], a)).toEqual({ approved: [t1], drafts: [t2] });
  });
  it('统计覆盖率', () => {
    expect(coverage([{ id: 'M-AC-1' }, { id: 'M-AC-2' }], [{ covers: ['M-AC-2', 'X-AC-9'] }])).toEqual({ covered: ['M-AC-2'], uncovered: ['M-AC-1'] });
  });
  it('跨模块加载被覆盖条款', async () => {
    const s = await store();
    await s.saveClauses('M', [clause('M-AC-1')]);
    await s.saveClauses('N', [clause('N-AC-1')]);
    const loaded = await loadCoveredClauses(s, [tc('M-TC-1', ['M-AC-1', 'N-AC-1'])]);
    expect(loaded.map((c) => c.id).sort()).toEqual(['M-AC-1', 'N-AC-1']);
  });
});
