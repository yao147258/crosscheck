import { describe, expect, it } from 'vitest';
import {
  Approvals,
  assertProfileApproved,
  GateError,
  selectExecutableCases,
  selectPlannableClauses,
  type Clause,
  type TestCase,
} from '../src/index';

const mkClause = (id: string, status: Clause['status'] = 'active'): Clause => ({
  id,
  text: `条款 ${id}`,
  source: { file: 'a.md', line: 1, excerpt: '' },
  status,
  notes: '',
});

const mkCase = (id: string, covers: string[]): TestCase => ({
  id,
  covers,
  fixtures: [],
  actor: 'member',
  steps: ['步骤'],
  expectations: [{ id: 'E1', text: '预期', evidence: ['screenshot'] }],
});

describe('selectPlannableClauses', () => {
  it('只有已确认且 active 的条款可以生成用例', () => {
    const a = Approvals.empty();
    const ok = mkClause('M-AC-1');
    const unapproved = mkClause('M-AC-2');
    const unclear = mkClause('M-AC-3', 'unclear');
    a.approve('clause', ok.id, ok, 'u');
    a.approve('clause', unclear.id, unclear, 'u');
    const sel = selectPlannableClauses([ok, unapproved, unclear], a);
    expect(sel.ready.map((c) => c.id)).toEqual(['M-AC-1']);
    expect(sel.blocked).toEqual([
      { id: 'M-AC-2', reason: '未确认' },
      { id: 'M-AC-3', reason: '状态为 unclear' },
    ]);
  });

  it('确认后被修改的条款不可用', () => {
    const a = Approvals.empty();
    const c = mkClause('M-AC-1');
    a.approve('clause', c.id, c, 'u');
    const sel = selectPlannableClauses([{ ...c, text: '改了' }], a);
    expect(sel.ready).toEqual([]);
    expect(sel.blocked[0]?.reason).toBe('确认已失效（内容已修改）');
  });
});

describe('selectExecutableCases', () => {
  it('用例本身和它覆盖的条款都必须已确认', () => {
    const a = Approvals.empty();
    const c1 = mkClause('M-AC-1');
    const c2 = mkClause('M-AC-2');
    a.approve('clause', c1.id, c1, 'u');
    const t1 = mkCase('M-TC-1', ['M-AC-1']);
    const t2 = mkCase('M-TC-2', ['M-AC-1', 'M-AC-2']);
    const t3 = mkCase('M-TC-3', ['M-AC-1']);
    a.approve('case', t1.id, t1, 'u');
    a.approve('case', t2.id, t2, 'u');
    const sel = selectExecutableCases([t1, t2, t3], [c1, c2], a);
    expect(sel.ready.map((t) => t.id)).toEqual(['M-TC-1']);
    expect(sel.blocked).toEqual([
      { id: 'M-TC-2', reason: '覆盖的条款不可用：M-AC-2' },
      { id: 'M-TC-3', reason: '未确认' },
    ]);
  });

  it('修改已确认用例后不可执行', () => {
    const a = Approvals.empty();
    const c1 = mkClause('M-AC-1');
    a.approve('clause', c1.id, c1, 'u');
    const t1 = mkCase('M-TC-1', ['M-AC-1']);
    a.approve('case', t1.id, t1, 'u');
    const sel = selectExecutableCases([{ ...t1, steps: ['别的步骤'] }], [c1], a);
    expect(sel.ready).toEqual([]);
  });
});

describe('assertProfileApproved', () => {
  it('全部画像文件已确认时通过', () => {
    const a = Approvals.empty();
    a.approve('profile', 'auth.yaml', { x: 1 }, 'u');
    expect(() => assertProfileApproved({ 'auth.yaml': { x: 1 } }, a)).not.toThrow();
  });

  it('有未确认或失效的文件时抛出 GateError 并列出原因', () => {
    const a = Approvals.empty();
    a.approve('profile', 'auth.yaml', { x: 1 }, 'u');
    try {
      assertProfileApproved({ 'auth.yaml': { x: 2 }, 'pages.yaml': {} }, a);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GateError);
      expect((err as GateError).blockers).toEqual(['auth.yaml：确认已失效（内容已修改）', 'pages.yaml：未确认']);
    }
  });
});
