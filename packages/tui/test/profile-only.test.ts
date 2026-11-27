import { afterEach, expect, it } from 'vitest';
import { AUTO_REVIEWER, PROFILE_FILES, readProfileFile, type ProfileFile } from '@crosscheck/core';
import { initialRoute, loadProfileOverview, type ReviewSession } from '../src/index';
import { cleanupProjects, createProject, PROFILE_FILES_CONTENT } from './fixture';

afterEach(cleanupProjects);

async function approve(session: ReviewSession, names: readonly ProfileFile[], by = '人工') {
  await session.mutate(async (approvals) => {
    for (const name of names) {
      const file = await readProfileFile(session.artifacts, name);
      if (!file.present || !file.ok) throw new Error(`画像无效：${name}`);
      approvals.approve('profile', name, file.value, by);
    }
  });
}

async function createCrossFileMismatch() {
  const { session, artifacts } = await createProject();
  const local = PROFILE_FILES_CONTENT['environments.yaml'].environments.local;
  await artifacts.writeYaml('system/environments.yaml', { version: 1, environments: { local: { ...local, reset: 'missing-reset' } } });
  return session;
}

it('only 过滤行，未过滤时七份齐全', async () => {
  const { session } = await createProject();
  expect((await loadProfileOverview(session)).rows).toHaveLength(7);
  const only = await loadProfileOverview(session, ['auth.yaml', 'guardrails.yaml']);
  expect(only.rows.map((row) => row.name)).toEqual(['auth.yaml', 'guardrails.yaml']);
});

it('只有当前已确认行带确认人，保留 auto 与人工原名', async () => {
  const { session, artifacts } = await createProject();
  await approve(session, ['pages.yaml'], AUTO_REVIEWER);
  await approve(session, ['auth.yaml', 'guardrails.yaml']);
  await artifacts.writeYaml('system/guardrails.yaml', { allowedHosts: ['localhost:40000'] });
  const { rows } = await loadProfileOverview(session);
  expect(rows.find((row) => row.name === 'pages.yaml')).toMatchObject({ status: 'approved', by: 'auto' });
  expect(rows.find((row) => row.name === 'auth.yaml')).toMatchObject({ status: 'approved', by: '人工' });
  expect(rows.find((row) => row.name === 'guardrails.yaml')).toMatchObject({ status: 'stale' });
  expect(rows.find((row) => row.name === 'guardrails.yaml')).not.toHaveProperty('by');
  expect(rows.find((row) => row.name === 'fixtures.yaml')).not.toHaveProperty('by');
});

it('只确认筛选内画像时不提前报告真实存在的跨文件错误', async () => {
  const session = await createCrossFileMismatch();
  await approve(session, ['environments.yaml']);
  const overview = await loadProfileOverview(session, ['environments.yaml']);
  expect(overview.rows.map(({ name, status }) => ({ name, status }))).toEqual([{ name: 'environments.yaml', status: 'approved' }]);
  expect(overview.crossCheck).toBeUndefined();
});

it('全部确认后，筛选仍报告筛选外文件的跨文件引用错误', async () => {
  const session = await createCrossFileMismatch();
  await approve(session, PROFILE_FILES);
  const overview = await loadProfileOverview(session, ['auth.yaml']);
  expect(overview.rows.map((row) => row.name)).toEqual(['auth.yaml']);
  expect(overview.crossCheck).toContain('环境 local 的 reset fixture 不存在：missing-reset');
});

it('全部确认且跨文件有效时，筛选不产生校验错误', async () => {
  const { session } = await createProject();
  await approve(session, PROFILE_FILES);
  const overview = await loadProfileOverview(session, ['auth.yaml']);
  expect(overview.rows.map((row) => row.name)).toEqual(['auth.yaml']);
  expect(overview.crossCheck).toBeUndefined();
});

it('initialRoute 只把非空 only 带入画像路由', () => {
  expect(initialRoute('profile', undefined, undefined, ['auth.yaml'])).toEqual({ name: 'profile', only: ['auth.yaml'] });
  expect(initialRoute('profile')).toEqual({ name: 'profile' });
  expect(initialRoute('profile', undefined, undefined, [])).toEqual({ name: 'profile' });
});
