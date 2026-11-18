import { afterEach, expect, it, vi } from 'vitest';
import { Approvals, loadProfile } from '@crosscheck/core';
import { loadStatus, recordDisposition, revokeClause } from '../src/index';
import { cleanupProjects, clause, createProject, testCase } from './fixture';
import { createFailedRun } from './run-fixture';

afterEach(async () => { vi.restoreAllMocks(); await cleanupProjects(); });

it('缺失画像和空条款、用例不能推断为完成，且读取绝不写入', async () => {
  const { artifacts } = await createProject({ profile: false });
  const context = { artifacts, approvals: await Approvals.load(artifacts) };
  const write = vi.spyOn(artifacts, 'writeBytes').mockRejectedValue(new Error('禁止写入'));
  const status = await loadStatus(context);
  expect(status.stage).toBe('profile');
  expect(status.profile).toMatchObject({ total: 7, pending: 7 });
  expect(status.profile.issues).toHaveLength(7);
  expect(status.clauses).toMatchObject({ total: 0, pending: 0 });
  expect(status.cases).toMatchObject({ total: 0, pending: 0 });
  expect(status.latestRun).toEqual({ state: 'missing' });
  expect(write).not.toHaveBeenCalled();
  expect(await artifacts.readBytes('approvals.json')).toBeUndefined();
});

it('依次推断条款、用例和执行阶段，不将空集合视为已完成', async () => {
  const { artifacts, session } = await createProject();
  await session.mutate(async (approvals) => {
    for (const [name, value] of Object.entries(await loadProfile(artifacts))) approvals.approve('profile', name, value, '人工');
  });
  expect((await loadStatus(session)).stage).toBe('clauses');
  await artifacts.saveClauses('M', [clause(1)]);
  expect((await loadStatus(session)).clauses.pending).toBe(1);
  await session.mutate((approvals) => approvals.approve('clause', 'M-AC-1', clause(1), '人工'));
  expect((await loadStatus(session)).stage).toBe('cases');
  await artifacts.saveCases('M', [testCase(1, ['M-AC-1'])]);
  expect((await loadStatus(session)).cases.pending).toBe(1);
  await session.mutate((approvals) => approvals.approveCase(testCase(1, ['M-AC-1']), [clause(1)], '人工'));
  expect((await loadStatus(session)).stage).toBe('run');
  await revokeClause(session, 'M', 'M-AC-1');
  expect((await loadStatus(session)).cases.pending).toBe(1);
});

it('多个模块仅部分条款有用例时保持用例阶段并报告未覆盖条款', async () => {
  const { artifacts, session } = await createProject();
  const first = clause(1);
  const second = clause(1, { id: 'N-AC-1' });
  const tc = testCase(1, ['M-AC-1']);
  await artifacts.saveClauses('M', [first]);
  await artifacts.saveClauses('N', [second]);
  await artifacts.saveCases('M', [tc]);
  await session.mutate(async (approvals) => {
    for (const [name, value] of Object.entries(await loadProfile(artifacts))) approvals.approve('profile', name, value, '人工');
    for (const item of [first, second]) approvals.approve('clause', item.id, item, '人工');
    approvals.approveCase(tc, [first], '人工');
  });
  const status = await loadStatus(session);
  expect(status.stage).toBe('cases');
  expect(status.cases.issues).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'incomplete', message: expect.stringContaining('N-AC-1') })]));
  const crossModule = testCase(2, ['N-AC-1']);
  await artifacts.saveCases('M', [tc, crossModule]);
  await session.mutate((approvals) => approvals.approveCase(crossModule, [second], '人工'));
  expect((await loadStatus(session)).stage).toBe('run');
});

it('真实最新运行按用例状态统计，并按预期统计未裁决结果', async () => {
  const { project, runId, result } = await createFailedRun();
  const { artifacts, session } = project;
  const before = await artifacts.readBytes(`runs/${runId}/results.json`);
  const write = vi.spyOn(artifacts, 'writeBytes').mockRejectedValue(new Error('禁止写入'));
  const status = await loadStatus(session);
  expect(status.stage).toBe('results');
  expect(status.latestRun).toMatchObject({ state: 'ready', runId, start: result.manifest.start, status: 'completed', resultStatus: 'FAIL', counts: { PASS: 0, FAIL: 1, DISPUTED: 0, UNCLEAR: 0, BLOCKED: 0 }, pendingDispositions: 2 });
  expect(write).not.toHaveBeenCalled();
  expect(await artifacts.readBytes(`runs/${runId}/results.json`)).toEqual(before);
  write.mockRestore();
  await recordDisposition(session, runId, { caseId: 'M-TC-1', expectationId: 'E1', decision: 'confirmed_bug', note: '' });
  expect((await loadStatus(session)).latestRun).toMatchObject({ pendingDispositions: 1 });
});

it('未完成运行、缺失清单和损坏运行均明确区分且不回退旧运行', async () => {
  const { project, runId } = await createFailedRun();
  const { artifacts, session } = project;
  const manifest = JSON.parse((await artifacts.readBytes(`runs/${runId}/manifest.json`))!.toString());
  await artifacts.writeJson(`runs/${runId}/manifest.json`, { ...manifest, status: 'running', end: null });
  expect((await loadStatus(session)).latestRun).toMatchObject({ state: 'incomplete', runId, status: 'running' });
  const newer = '99991231T235959999Z-' + 'a'.repeat(32);
  await artifacts.writeJson(`runs/${newer}/placeholder.json`, {});
  expect((await loadStatus(session)).latestRun).toMatchObject({ state: 'missing', runId: newer });
  await artifacts.writeBytes(`runs/${newer}/manifest.json`, Buffer.from('{bad'));
  expect((await loadStatus(session)).latestRun).toMatchObject({ state: 'corrupt', runId: newer, error: expect.any(String) });
});

it('完成运行的汇总缺失时仍报告已知运行时间和状态', async () => {
  const { project, runId, result } = await createFailedRun();
  await project.artifacts.remove(`runs/${runId}/results.json`);
  expect((await loadStatus(project.session)).latestRun).toMatchObject({ state: 'missing', runId, start: result.manifest.start, status: 'completed' });
});

it('损坏条款及裁决文件分别报告未知统计而非零或成功', async () => {
  const { project, runId } = await createFailedRun();
  const { artifacts, session } = project;
  await artifacts.writeBytes('requirements/M.yaml', Buffer.from('bad: ['));
  await artifacts.writeJson(`runs/${runId}/dispositions.json`, { version: 1, runId: 'other', items: [] });
  const status = await loadStatus(session);
  expect(status.clauses).toMatchObject({ total: null, pending: null });
  expect(status.clauses.issues).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'corrupt' })]));
  expect(status.latestRun).toMatchObject({ state: 'corrupt', runId, error: expect.any(String) });
  expect(status.stage).toBe('clauses');
});
