import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { Approvals, assertStoredProfileApproved, loadProfile } from '@crosscheck/core';
import {
  ReviewSession, approveAllCases, approveAllClauses, approveCase, approveClause, approveProfileFile,
  deleteCase, deleteClause, editCase, editClause, editProfileFile, listReviewModules,
  loadCaseOverview, loadClauseRows, loadHomeSummary, loadProfileOverview, markClauseUnclear, revokeCase, revokeClause,
  revokeProfileFile, type EditorHost,
} from '../src/index';
import { cleanupProjects, clause, createProject, testCase } from './fixture';

afterEach(async () => { vi.restoreAllMocks(); await cleanupProjects(); });
const editorReturning = (...outputs: string[]): EditorHost => ({ async edit(text) { return outputs.shift() ?? text; } });

it('无确认人的只读上下文读取摘要，与审核会话结果一致且不写确认', async () => {
  const { artifacts, session } = await createProject();
  await artifacts.saveClauses('M', [clause(1), clause(2)]);
  await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
  await approveClause(session, 'M', 'M-AC-1');
  const before = await artifacts.readBytes('approvals.json');
  const context = { artifacts, approvals: await Approvals.load(artifacts) };
  expect(await loadHomeSummary(context)).toEqual({ profilePending: 7, clausesPending: 1, casesPending: 1, runs: 0 });
  expect(await loadHomeSummary(session)).toEqual(await loadHomeSummary(context));
  expect(await artifacts.readBytes('approvals.json')).toEqual(before);
});

describe('画像', () => {
  it('区分缺失、语法错误、schema 错误与未确认，拒绝非法确认', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.remove('system/pages.yaml');
    await artifacts.writeYaml('system/guardrails.yaml', { allowedHosts: [] });
    await artifacts.writeBytes('system/auth.yaml', Buffer.from('actors: [bad'));
    const overview = await loadProfileOverview(session);
    expect(overview.rows).toHaveLength(7);
    expect(overview.rows.find((r) => r.name === 'pages.yaml')?.status).toBe('missing');
    for (const name of ['auth.yaml', 'guardrails.yaml']) {
      expect(overview.rows.find((r) => r.name === name)).toMatchObject({ status: 'invalid', error: expect.any(String) });
    }
    expect(overview.rows.find((r) => r.name === 'fixtures.yaml')?.status).toBe('none');
    await expect(approveProfileFile(session, 'guardrails.yaml')).rejects.toThrow('不能确认');
    await expect(approveProfileFile(session, 'pages.yaml')).rejects.toThrow('不存在');
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
  });

  it('确认使用带默认值解析结果，重新打开会话仍通过运行门禁，撤销持久化', async () => {
    const { session, artifacts } = await createProject();
    for (const row of (await loadProfileOverview(session)).rows) expect(await approveProfileFile(session, row.name)).toContain('已确认');
    const reopened = await ReviewSession.open(artifacts, '另一个人');
    const profile = await loadProfile(artifacts);
    expect(profile['guardrails.yaml']).toEqual({ allowedHosts: ['localhost:39999'], forbidden: [], redactFields: [] });
    await expect(assertStoredProfileApproved(artifacts, reopened.approvals)).resolves.toEqual(profile);
    expect((await loadProfileOverview(reopened)).rows.every((r) => r.status === 'approved')).toBe(true);
    expect((await loadProfileOverview(reopened)).crossCheck).toBeUndefined();
    await revokeProfileFile(reopened, 'auth.yaml');
    expect((await loadProfileOverview(await ReviewSession.open(artifacts, '测试人'))).rows.find((r) => r.name === 'auth.yaml')?.status).toBe('none');
  });

  it('单文件可确认，全部确认时才报告跨文件引用错误', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.writeYaml('system/fixtures.yaml', { version: 1, fixtures: { reset: { kind: 'http', operation: 'missing' } } });
    await approveProfileFile(session, 'fixtures.yaml');
    expect((await loadProfileOverview(session)).crossCheck).toBeUndefined();
    for (const row of (await loadProfileOverview(session)).rows) await approveProfileFile(session, row.name);
    expect((await loadProfileOverview(session)).crossCheck).toContain('missing');
    await expect(assertStoredProfileApproved(artifacts, session.approvals)).rejects.toThrow();
  });

  it('编辑保留原文注释、schema 校验重试，内容改变后确认失效，未改不写', async () => {
    const { session, artifacts } = await createProject();
    await approveProfileFile(session, 'guardrails.yaml');
    const text = '#! 用户注释\nallowedHosts:\n  - localhost:4000\n';
    expect(await editProfileFile(session, editorReturning('allowedHosts: []\n', text), 'guardrails.yaml')).toContain('已保存');
    expect((await artifacts.readBytes('system/guardrails.yaml'))!.toString()).toBe(text);
    expect((await loadProfileOverview(session)).rows.find((r) => r.name === 'guardrails.yaml')?.status).toBe('stale');
    const before = await artifacts.readBytes('approvals.json');
    expect(await editProfileFile(session, editorReturning(), 'guardrails.yaml')).toBe('未修改');
    expect(await artifacts.readBytes('approvals.json')).toEqual(before);
  });

  it('缺失文件可以编辑创建，校验失败后原样关闭不落盘', async () => {
    const { session, artifacts } = await createProject({ profile: false });
    expect(await editProfileFile(session, editorReturning('version: 1\npages: {}\n'), 'pages.yaml')).toContain('已保存');
    expect((await loadProfileOverview(session)).rows.find((r) => r.name === 'pages.yaml')?.status).toBe('none');
    expect(await editProfileFile(session, editorReturning('bad: true\n'), 'auth.yaml')).toBe('未修改');
    expect(await artifacts.readBytes('system/auth.yaml')).toBeUndefined();
  });
});

describe('条款', () => {
  it('合并需求与用例模块，去重排序', async () => {
    const { session, artifacts } = await createProject();
    expect(await listReviewModules(session)).toEqual([]);
    await artifacts.saveClauses('Z', []);
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', []);
    await artifacts.saveCases('A', []);
    expect(await listReviewModules(session)).toEqual(['A', 'M', 'Z']);
    expect(await loadClauseRows(session, 'missing')).toEqual([]);
  });

  it('只确认 active、批量跳过已确认与非 active，unclear 撤销、删除持久化', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2), clause(3, { status: 'unclear' }), clause(4, { status: 'removed' })]);
    for (const id of ['M-AC-3', 'M-AC-4']) await expect(approveClause(session, 'M', id)).rejects.toThrow('active');
    await approveClause(session, 'M', 'M-AC-1');
    expect((await loadClauseRows(session, 'M')).map((r) => r.approval)).toEqual(['approved', 'none', 'none', 'none']);
    await revokeClause(session, 'M', 'M-AC-1');
    expect((await loadClauseRows(await ReviewSession.open(artifacts, '测试人'), 'M'))[0]?.approval).toBe('none');
    expect(await approveAllClauses(session, 'M')).toBe('已确认 2 条条款');
    const record = session.approvals.record('clause', 'M-AC-1');
    expect(await approveAllClauses(session, 'M')).toBe('已确认 0 条条款');
    expect(session.approvals.record('clause', 'M-AC-1')).toEqual(record);
    await markClauseUnclear(session, 'M', 'M-AC-2');
    expect((await loadClauseRows(await ReviewSession.open(artifacts, '测试人'), 'M'))[1]).toMatchObject({ clause: { status: 'unclear' }, approval: 'none' });
    await deleteClause(session, 'M', 'M-AC-1');
    expect((await artifacts.loadClauses('M')).map((c) => c.id)).toEqual(['M-AC-2', 'M-AC-3', 'M-AC-4']);
    expect((await ReviewSession.open(artifacts, '测试人')).approvals.record('clause', 'M-AC-1')).toBeUndefined();
  });

  it('编辑禁止改 ID，修正后保存且确认失效，保留其他条款', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2)]);
    await approveClause(session, 'M', 'M-AC-1');
    const fixed = YAML.stringify(clause(1, { text: '新条款' }));
    expect(await editClause(session, editorReturning(fixed.replace('M-AC-1', 'M-AC-9'), fixed), 'M', 'M-AC-1')).toBe('已保存 M-AC-1');
    expect(await artifacts.loadClauses('M')).toEqual([clause(1, { text: '新条款' }), clause(2)]);
    expect((await loadClauseRows(session, 'M'))[0]?.approval).toBe('stale');
    const before = await artifacts.readBytes('requirements/M.yaml');
    expect(await editClause(session, editorReturning(), 'M', 'M-AC-1')).toBe('未修改');
    expect(await editClause(session, editorReturning(fixed.replace('M-AC-1', 'M-AC-9')), 'M', 'M-AC-1')).toBe('未修改');
    expect(await artifacts.readBytes('requirements/M.yaml')).toEqual(before);
  });
});

describe('用例', () => {
  it('所有覆盖条款须 approved+active，按首条覆盖分组，只统计已确认用例覆盖率', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2), clause(3), clause(4, { status: 'unclear' })]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1']), testCase(2, ['M-AC-2']), testCase(3, ['M-AC-1', 'M-AC-2']), testCase(4, ['M-AC-4']), testCase(5, ['M-AC-99'])]);
    await expect(approveCase(session, 'M', 'M-TC-1')).rejects.toThrow('M-AC-1');
    await approveClause(session, 'M', 'M-AC-1');
    await approveClause(session, 'M', 'M-AC-3');
    await approveCase(session, 'M', 'M-TC-1');
    await expect(approveCase(session, 'M', 'M-TC-3')).rejects.toThrow('M-AC-2');
    await session.mutate((a) => a.approve('clause', 'M-AC-4', clause(4, { status: 'unclear' }), '测试人'));
    await expect(approveCase(session, 'M', 'M-TC-4')).rejects.toThrow('M-AC-4');
    await expect(approveCase(session, 'M', 'M-TC-5')).rejects.toThrow('M-AC-99');
    const overview = await loadCaseOverview(session, 'M');
    expect(overview.rows.map((r) => r.approval)).toEqual(['approved', 'none', 'none', 'none', 'none']);
    expect(overview.coverage).toEqual({ covered: ['M-AC-1'], uncovered: ['M-AC-3'] });
    expect(overview.groups).toEqual([{ clauseId: 'M-AC-1', caseIds: ['M-TC-1', 'M-TC-3'] }]);
    expect(overview.ungrouped).toEqual(['M-TC-2', 'M-TC-4', 'M-TC-5']);
    expect(await approveAllCases(session, 'M')).toBe('已确认 0 个用例，跳过 4 个（覆盖的条款未全部确认）');
    await approveClause(session, 'M', 'M-AC-2');
    expect(await approveAllCases(session, 'M')).toBe('已确认 2 个用例，跳过 2 个（覆盖的条款未全部确认）');
    expect((await loadCaseOverview(await ReviewSession.open(artifacts, '测试人'), 'M')).coverage).toEqual({ covered: ['M-AC-1', 'M-AC-2'], uncovered: ['M-AC-3'] });
  });

  it('跨模块加载覆盖条款，与本模块重复加载不能误判为 stale', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveClauses('N', [clause(1, { id: 'N-AC-1' })]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1', 'N-AC-1']), testCase(2, ['N-AC-1'])]);
    await approveClause(session, 'M', 'M-AC-1');
    await expect(approveCase(session, 'M', 'M-TC-1')).rejects.toThrow('N-AC-1');
    await approveClause(session, 'N', 'N-AC-1');
    expect(await approveAllCases(session, 'M')).toBe('已确认 2 个用例');
    const overview = await loadCaseOverview(await ReviewSession.open(artifacts, '测试人'), 'M');
    expect(overview.rows.map((r) => r.approval)).toEqual(['approved', 'approved']);
    expect(overview.groups).toEqual([{ clauseId: 'M-AC-1', caseIds: ['M-TC-1'] }]);
    expect(overview.ungrouped).toEqual(['M-TC-2']);
    await artifacts.saveClauses('N', [clause(1, { id: 'N-AC-1', text: '外部条款改变' })]);
    expect((await loadCaseOverview(session, 'M')).rows.map((r) => r.approval)).toEqual(['stale', 'stale']);
  });

  it.each(['edit', 'revoke', 'unclear', 'delete'] as const)('条款 %s 后用例失效且不贡献覆盖率', async (action) => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1', 'M-AC-2'])]);
    await approveAllClauses(session, 'M');
    await approveCase(session, 'M', 'M-TC-1');
    if (action === 'edit') await artifacts.saveClauses('M', [clause(1, { text: '改了' }), clause(2)]);
    if (action === 'revoke') await revokeClause(session, 'M', 'M-AC-1');
    if (action === 'unclear') await markClauseUnclear(session, 'M', 'M-AC-1');
    if (action === 'delete') await deleteClause(session, 'M', 'M-AC-1');
    const reopened = await ReviewSession.open(artifacts, '测试人');
    const overview = await loadCaseOverview(reopened, 'M');
    expect(overview.rows[0]?.approval).toBe('stale');
    expect(overview.coverage).toEqual({ covered: [], uncovered: ['M-AC-2'] });
    await expect(approveCase(reopened, 'M', 'M-TC-1')).rejects.toThrow('M-AC-1');
  });

  it('无关条款变化不影响用例，条款与用例 stale 均可重新批量确认', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
    await approveAllClauses(session, 'M');
    await approveAllCases(session, 'M');
    await artifacts.saveClauses('M', [clause(1), clause(2, { text: '无关变化' })]);
    expect((await loadCaseOverview(session, 'M')).rows[0]?.approval).toBe('approved');
    await artifacts.saveClauses('M', [clause(1, { text: '覆盖条款变化' }), clause(2, { text: '无关变化' })]);
    expect(await approveAllCases(session, 'M')).toBe('已确认 0 个用例，跳过 1 个（覆盖的条款未全部确认）');
    expect(await approveAllClauses(session, 'M')).toBe('已确认 2 条条款');
    expect((await loadCaseOverview(session, 'M')).rows[0]?.approval).toBe('stale');
    expect(await approveAllCases(session, 'M')).toBe('已确认 1 个用例');
    const record = session.approvals.record('case', 'M-TC-1');
    expect(await approveAllCases(session, 'M')).toBe('已确认 0 个用例');
    expect(session.approvals.record('case', 'M-TC-1')).toEqual(record);
    expect((await loadCaseOverview(await ReviewSession.open(artifacts, '测试人'), 'M')).rows[0]?.approval).toBe('approved');
  });

  it('撤销、删除用例持久化，编辑禁止改 ID 且修改后失效', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1']), testCase(2, ['M-AC-1'])]);
    await approveClause(session, 'M', 'M-AC-1');
    await approveAllCases(session, 'M');
    const fixed = YAML.stringify(testCase(1, ['M-AC-1'], { steps: ['新步骤'] }));
    expect(await editCase(session, editorReturning(fixed.replace('M-TC-1', 'M-TC-9'), fixed), 'M', 'M-TC-1')).toBe('已保存 M-TC-1');
    expect((await loadCaseOverview(session, 'M')).rows.map((r) => r.approval)).toEqual(['stale', 'approved']);
    const before = await artifacts.readBytes('cases/M.yaml');
    expect(await editCase(session, editorReturning(), 'M', 'M-TC-1')).toBe('未修改');
    expect(await editCase(session, editorReturning('id: bad\n'), 'M', 'M-TC-1')).toBe('未修改');
    expect(await artifacts.readBytes('cases/M.yaml')).toEqual(before);
    await revokeCase(session, 'M', 'M-TC-2');
    expect((await loadCaseOverview(await ReviewSession.open(artifacts, '测试人'), 'M')).rows[1]?.approval).toBe('none');
    await deleteCase(session, 'M', 'M-TC-1');
    expect(await artifacts.loadCases('M')).toEqual([testCase(2, ['M-AC-1'])]);
    expect((await ReviewSession.open(artifacts, '测试人')).approvals.record('case', 'M-TC-1')).toBeUndefined();
  });
});

describe('失败与一致性边界', () => {
  it('不存在的条款与用例操作均拒绝且不创建确认文件', async () => {
    const { session, artifacts } = await createProject();
    for (const action of [approveClause, revokeClause, markClauseUnclear, deleteClause, approveCase, revokeCase, deleteCase]) {
      await expect(action(session, 'M', 'M-AC-99')).rejects.toThrow('不存在');
    }
    await expect(editClause(session, editorReturning(), 'M', 'M-AC-99')).rejects.toThrow('不存在');
    await expect(editCase(session, editorReturning(), 'M', 'M-TC-99')).rejects.toThrow('不存在');
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
    expect(await loadCaseOverview(session, 'M')).toEqual({ rows: [], groups: [], ungrouped: [], coverage: { covered: [], uncovered: [] } });
  });

  it('批量确认落盘失败后重载，无半成品确认，重试可持久化', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2)]);
    const fail = vi.spyOn(artifacts, 'writeJson').mockRejectedValueOnce(new Error('确认保存失败'));
    await expect(approveAllClauses(session, 'M')).rejects.toThrow('确认保存失败');
    expect((await loadClauseRows(session, 'M')).map((r) => r.approval)).toEqual(['none', 'none']);
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
    fail.mockRestore();
    await approveAllClauses(session, 'M');
    expect((await loadClauseRows(await ReviewSession.open(artifacts, '测试人'), 'M')).map((r) => r.approval)).toEqual(['approved', 'approved']);
  });

  it('标 unclear 工件保存失败时不撤销确认；确认保存失败不回滚已写工件', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await approveClause(session, 'M', 'M-AC-1');
    vi.spyOn(artifacts, 'saveClauses').mockRejectedValueOnce(new Error('工件保存失败'));
    await expect(markClauseUnclear(session, 'M', 'M-AC-1')).rejects.toThrow('工件保存失败');
    expect((await loadClauseRows(session, 'M'))[0]).toMatchObject({ clause: { status: 'active' }, approval: 'approved' });
    vi.spyOn(artifacts, 'writeJson').mockRejectedValueOnce(new Error('确认保存失败'));
    await expect(markClauseUnclear(session, 'M', 'M-AC-1')).rejects.toThrow('确认保存失败');
    expect((await loadClauseRows(session, 'M'))[0]).toMatchObject({ clause: { status: 'unclear' }, approval: 'stale' });
    expect((await loadClauseRows(await ReviewSession.open(artifacts, '测试人'), 'M'))[0]?.approval).toBe('stale');
  });

  it.each(['clause', 'case', 'profile'] as const)('%s 编辑失败不保存工件，也不改确认', async (kind) => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
    await approveAllClauses(session, 'M');
    await approveAllCases(session, 'M');
    await approveProfileFile(session, 'auth.yaml');
    const before = await artifacts.readBytes('approvals.json');
    const editor: EditorHost = { async edit() { throw new Error('编辑器失败'); } };
    const promise = kind === 'clause' ? editClause(session, editor, 'M', 'M-AC-1')
      : kind === 'case' ? editCase(session, editor, 'M', 'M-TC-1') : editProfileFile(session, editor, 'auth.yaml');
    await expect(promise).rejects.toThrow('编辑器失败');
    expect(await artifacts.loadClauses('M')).toEqual([clause(1)]);
    expect(await artifacts.loadCases('M')).toEqual([testCase(1, ['M-AC-1'])]);
    expect(await artifacts.readBytes('approvals.json')).toEqual(before);
  });

  it.each(['clause', 'case', 'profile'] as const)('%s 保存写入失败保留原文和确认', async (kind) => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
    await approveAllClauses(session, 'M');
    await approveAllCases(session, 'M');
    await approveProfileFile(session, 'guardrails.yaml');
    const before = await artifacts.readBytes('approvals.json');
    const rel = kind === 'clause' ? 'requirements/M.yaml' : kind === 'case' ? 'cases/M.yaml' : 'system/guardrails.yaml';
    const original = await artifacts.readBytes(rel);
    const writeBytes = artifacts.writeBytes.bind(artifacts);
    vi.spyOn(artifacts, 'writeBytes').mockImplementation(async (file, bytes) => {
      if (file === rel) throw new Error('工件写入失败');
      await writeBytes(file, bytes);
    });
    const editor: EditorHost = { async edit(text) { return text.replace('条款 1', '新条款').replace('检查接口', '新步骤').replace('39999', '4000'); } };
    const promise = kind === 'clause' ? editClause(session, editor, 'M', 'M-AC-1')
      : kind === 'case' ? editCase(session, editor, 'M', 'M-TC-1') : editProfileFile(session, editor, 'guardrails.yaml');
    await expect(promise).rejects.toThrow('工件写入失败');
    expect(await artifacts.readBytes(rel)).toEqual(original);
    expect(await artifacts.readBytes('approvals.json')).toEqual(before);
  });

  it('用例批量确认保存失败不泄漏确认，删除工件失败保留原用例和确认', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1']), testCase(2, ['M-AC-1'])]);
    await approveAllClauses(session, 'M');
    vi.spyOn(artifacts, 'writeJson').mockRejectedValueOnce(new Error('确认保存失败'));
    await expect(approveAllCases(session, 'M')).rejects.toThrow('确认保存失败');
    expect((await loadCaseOverview(session, 'M')).rows.map((r) => r.approval)).toEqual(['none', 'none']);
    await approveAllCases(session, 'M');
    vi.spyOn(artifacts, 'saveCases').mockRejectedValueOnce(new Error('删除保存失败'));
    await expect(deleteCase(session, 'M', 'M-TC-1')).rejects.toThrow('删除保存失败');
    expect((await loadCaseOverview(await ReviewSession.open(artifacts, '测试人'), 'M')).rows.map((r) => r.approval)).toEqual(['approved', 'approved']);
  });

  it.each(['clause', 'case', 'profile'] as const)('%s 编辑期间目标变化时拒绝覆盖', async (kind) => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
    const rel = kind === 'clause' ? 'requirements/M.yaml' : kind === 'case' ? 'cases/M.yaml' : 'system/guardrails.yaml';
    let latest: Buffer | undefined;
    const editor: EditorHost = { async edit(text) {
      if (kind === 'clause') await artifacts.saveClauses('M', [clause(1, { text: '外部修改' })]);
      else if (kind === 'case') await artifacts.saveCases('M', [testCase(1, ['M-AC-1'], { steps: ['外部修改'] })]);
      else await artifacts.writeYaml(rel, { allowedHosts: ['localhost:5000'] });
      latest = await artifacts.readBytes(rel);
      return text.replace('条款 1', '编辑修改').replace('检查接口', '编辑修改').replace('39999', '4000');
    } };
    const promise = kind === 'clause' ? editClause(session, editor, 'M', 'M-AC-1')
      : kind === 'case' ? editCase(session, editor, 'M', 'M-TC-1') : editProfileFile(session, editor, 'guardrails.yaml');
    await expect(promise).rejects.toThrow('编辑期间已变化');
    expect(await artifacts.readBytes(rel)).toEqual(latest);
    expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
  });

  it('同会话忙碌时所有写操作均拒绝，不写工件或确认', async () => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
    await approveAllClauses(session, 'M');
    const before = await artifacts.readBytes('approvals.json');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = session.mutate(async () => { await gate; });
    try {
      for (const action of [approveClause, revokeClause, markClauseUnclear, deleteClause, approveCase, revokeCase, deleteCase]) {
        await expect(action(session, 'M', action === approveCase || action === revokeCase || action === deleteCase ? 'M-TC-1' : 'M-AC-1')).rejects.toThrow('忙碌');
      }
      await expect(approveAllClauses(session, 'M')).rejects.toThrow('忙碌');
      await expect(approveAllCases(session, 'M')).rejects.toThrow('忙碌');
      await expect(approveProfileFile(session, 'auth.yaml')).rejects.toThrow('忙碌');
      await expect(revokeProfileFile(session, 'auth.yaml')).rejects.toThrow('忙碌');
      const editor: EditorHost = { async edit(text) { return text.replace('条款 1', '新条款').replace('检查接口', '新步骤').replace('39999', '4000'); } };
      await expect(editClause(session, editor, 'M', 'M-AC-1')).rejects.toThrow('忙碌');
      await expect(editCase(session, editor, 'M', 'M-TC-1')).rejects.toThrow('忙碌');
      await expect(editProfileFile(session, editor, 'guardrails.yaml')).rejects.toThrow('忙碌');
      expect(await artifacts.loadClauses('M')).toEqual([clause(1)]);
      expect(await artifacts.loadCases('M')).toEqual([testCase(1, ['M-AC-1'])]);
      expect((await artifacts.readBytes('system/guardrails.yaml'))!.toString()).toContain('39999');
      expect(await artifacts.readBytes('approvals.json')).toEqual(before);
    } finally {
      release();
      await pending;
    }
  });

  it.each(['clause', 'case'] as const)('%s 编辑期间其他条目变化不会被旧快照覆盖', async (kind) => {
    const { session, artifacts } = await createProject();
    await artifacts.saveClauses('M', [clause(1), clause(2)]);
    await artifacts.saveCases('M', [testCase(1, ['M-AC-1']), testCase(2, ['M-AC-2'])]);
    const editor: EditorHost = { async edit(text) {
      if (kind === 'clause') await deleteClause(session, 'M', 'M-AC-2');
      else await deleteCase(session, 'M', 'M-TC-2');
      return text.replace(kind === 'clause' ? '条款 1' : '检查接口', '编辑后的内容');
    } };
    if (kind === 'clause') {
      await editClause(session, editor, 'M', 'M-AC-1');
      expect(await artifacts.loadClauses('M')).toEqual([clause(1, { text: '编辑后的内容' })]);
    } else {
      await editCase(session, editor, 'M', 'M-TC-1');
      expect(await artifacts.loadCases('M')).toEqual([testCase(1, ['M-AC-1'], { steps: ['编辑后的内容'] })]);
    }
  });
});
