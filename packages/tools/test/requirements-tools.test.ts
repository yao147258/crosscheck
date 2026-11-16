import { describe, expect, it } from 'vitest';
import { grantTools } from '@crosscheck/agent';
import { Approvals, ClauseSchema, type Clause } from '@crosscheck/core';
import {
  createRequirementsTools,
  MAX_REQUIREMENT_RESULTS,
  RequirementsSearchSchema,
  searchRequirements,
} from '../src/index';

const clause = (n: number, text = `用户可以下单 ${n}`, status: Clause['status'] = 'active') =>
  ClauseSchema.parse({
    id: `M-AC-${n}`,
    text,
    source: { file: 'r.md', line: n, excerpt: text },
    status,
    notes: `内部备注 ${n}`,
  });

const context = () => ({ signal: new AbortController().signal });

describe('requirements_search', () => {
  it('只返回已确认且 active 的条款原文与来源，不含备注或确认记录', async () => {
    const approvals = Approvals.empty();
    const ok = clause(1);
    const unapproved = clause(2);
    const unclear = clause(3, '模糊', 'unclear');
    const removed = clause(4, '已删除', 'removed');
    const stale = clause(5);
    for (const item of [ok, unclear, removed, stale]) approvals.approve('clause', item.id, item, 'u');
    const [tool] = createRequirementsTools([ok, unapproved, unclear, removed, { ...stale, text: '确认后已修改' }], approvals);

    expect(tool).toMatchObject({ name: 'requirements_search', category: 'requirements' });
    const out = await tool!.execute({ query: '', ids: ['M-AC-1', 'M-AC-2', 'M-AC-3', 'M-AC-4', 'M-AC-5'] }, context());
    expect(out).toEqual({
      items: [{ id: 'M-AC-1', text: '用户可以下单 1', source: { file: 'r.md', line: 1, excerpt: '用户可以下单 1' } }],
    });
  });

  it('按正文或 ID 匹配关键词，忽略大小写与首尾空白', () => {
    expect(searchRequirements([clause(1, 'Login Required')], { query: '  login  ' }).map((item) => item.id)).toEqual(['M-AC-1']);
    expect(searchRequirements([clause(7)], { query: 'm-ac-7' }).map((item) => item.id)).toEqual(['M-AC-7']);
  });

  it('搜索来源摘录，但不搜索文件名与内部备注', () => {
    const item = clause(1, '允许提交订单');
    item.source = { file: 'private-file.md', line: 1, excerpt: 'Checkout Required' };
    item.notes = 'private-note';
    expect(searchRequirements([item], { query: 'checkout' }).map((result) => result.id)).toEqual(['M-AC-1']);
    expect(searchRequirements([item], { query: 'private-file' })).toEqual([]);
    expect(searchRequirements([item], { query: 'private-note' })).toEqual([]);
  });

  it('按 ids 精确匹配并与关键词取交集，保持原条款顺序且不重复结果', () => {
    const clauses = [clause(1, '登录'), clause(2), clause(3)];
    const ids = ['M-AC-3', 'M-AC-1', 'M-AC-2', 'M-AC-2', 'M-AC-99'];
    expect(searchRequirements(clauses, { ids }).map((item) => item.id)).toEqual(['M-AC-1', 'M-AC-2', 'M-AC-3']);
    expect(searchRequirements(clauses, { query: '下单', ids: ['M-AC-1', 'M-AC-3'] }).map((item) => item.id)).toEqual(['M-AC-3']);
    expect(searchRequirements(clauses, { ids: ['M-AC-99'] })).toEqual([]);
  });

  it('关键词和 ids 检索均最多返回 20 条，先过滤再截断', async () => {
    const clauses = Array.from({ length: 31 }, (_, i) => clause(i + 1, i === 0 ? '登录' : `下单 ${i + 1}`));
    const results = searchRequirements(clauses, { query: '下单' });
    expect(results).toHaveLength(20);
    expect(results).toHaveLength(MAX_REQUIREMENT_RESULTS);
    expect(results[0]?.id).toBe('M-AC-2');
    expect(results.at(-1)?.id).toBe('M-AC-21');
    const approvals = Approvals.empty();
    for (const item of clauses) approvals.approve('clause', item.id, item, 'u');
    const [tool] = createRequirementsTools(clauses, approvals);
    const out = await tool!.execute({ ids: clauses.map((item) => item.id) }, context());
    expect(out).toMatchObject({ items: expect.any(Array) });
    expect((out as { items: unknown[] }).items).toHaveLength(20);
  });

  it('没有可用条款或没有命中时返回空数组', async () => {
    const [tool] = createRequirementsTools([clause(1)], Approvals.empty());
    expect(await tool!.execute({ query: '下单' }, context())).toEqual({ items: [] });
    expect(searchRequirements([clause(1)], { query: '不存在' })).toEqual([]);
    expect(searchRequirements([], { query: '下单' })).toEqual([]);
  });

  it('检索不修改条款或确认记录，只向 planner 授予条款读取工具', async () => {
    const clauses = [clause(1), clause(2)];
    const approvals = Approvals.empty();
    approvals.approve('clause', 'M-AC-1', clauses[0], 'u');
    const before = structuredClone(clauses);
    const record = structuredClone(approvals.record('clause', 'M-AC-1'));
    const tools = createRequirementsTools(clauses, approvals);
    expect(tools.map((tool) => tool.name)).toEqual(['requirements_search']);
    expect(grantTools('plan', tools)).toEqual({ granted: tools, denied: [] });
    expect(grantTools('execute', tools)).toEqual({ granted: [], denied: tools });
    const [tool] = tools;
    await tool!.execute(tool!.input.parse({ query: '下单' }), context());
    expect(clauses).toEqual(before);
    expect(approvals.record('clause', 'M-AC-1')).toEqual(record);
    expect(approvals.state('clause', 'M-AC-1', clauses[0])).toBe('approved');
    expect(approvals.state('clause', 'M-AC-2', clauses[1])).toBe('none');
  });

  it.each([
    {},
    { query: '' },
    { query: '  ' },
    { ids: [] },
    { query: '  ', ids: [] },
    { query: '下'.repeat(201) },
    { ids: Array.from({ length: 51 }, () => 'M-AC-1') },
    { ids: ['bad-id'] },
    { query: 123 },
    { query: '下单', file: '../approvals.json' },
    { query: '下单', url: 'https://example.com' },
  ])('拒绝空检索、非法参数或额外能力参数：%j', (input) => {
    expect(RequirementsSearchSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { query: '下单' },
    { query: '下'.repeat(200) },
    { ids: ['M-AC-1'] },
    { ids: Array.from({ length: 50 }, () => 'M-AC-1') },
    { query: '', ids: ['M-AC-1'] },
    { query: '下单', ids: [] },
  ])('接受有效关键词或条款 ID：%j', (input) => {
    expect(RequirementsSearchSchema.safeParse(input).success).toBe(true);
  });
});
