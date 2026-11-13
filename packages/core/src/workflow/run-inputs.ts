import { Approvals, type ApprovalState } from '../approvals/approvals';
import { contentHash } from '../approvals/hash';
import type { Clause, TestCase } from '../schema/artifacts';
import type { Config } from '../schema/config';
import { PROFILE_FILES, type Profile, type ProfileFile } from '../schema/profile';
import { ArtifactError, type ArtifactStore } from '../store/artifact-store';
import { assertStoredProfileApproved, selectExecutableCases, type Selection } from './gate';

export interface RunInputOptions { environment?: string; modules?: string[]; caseIds?: string[] }
export interface VerifiedRunInputs {
  config: Config;
  profile: Profile;
  clauses: Clause[];
  cases: TestCase[];
  environment: string;
  modules: string[];
  selection: Selection<TestCase>;
  missingFixtures: string[];
  approvals: {
    profile: Record<ProfileFile, ApprovalState>;
    clauses: Record<string, ApprovalState>;
    cases: Record<string, ApprovalState>;
  };
  fingerprint: string;
}

function assertUnique(items: { id: string }[], label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new ArtifactError(`跨模块${label} ID 重复：${item.id}`);
    seen.add(item.id);
  }
}
function assertKnown(requested: string[] | undefined, available: string[], label: string): void {
  for (const name of requested ?? []) if (!available.includes(name)) throw new ArtifactError(`未知${label}：${name}`);
}

/** 纯读取和验证入口；只有此函数成功返回后，宿主才能启动进程、网络或真实模型。 */
export async function loadVerifiedRunInputs(store: ArtifactStore, options: RunInputOptions = {}): Promise<VerifiedRunInputs> {
  const approvals = await Approvals.load(store);
  const profile = await assertStoredProfileApproved(store, approvals);
  const config = await store.loadConfig();
  const environment = options.environment ?? config.defaultEnvironment;
  if (!environment || !Object.hasOwn(profile['environments.yaml'].environments, environment)) throw new ArtifactError(`运行环境不存在或未指定：${environment ?? '未指定'}`);
  const modules = [...new Set([...(await store.listModules('requirements')), ...(await store.listModules('cases'))])].sort();
  const entries = await Promise.all(modules.map(async (module) => ({ module, clauses: await store.loadClauses(module), cases: await store.loadCases(module) })));
  const clauses = entries.flatMap((entry) => entry.clauses);
  const allCases = entries.flatMap((entry) => entry.cases);
  assertUnique(clauses, '条款');
  assertUnique(allCases, '用例');
  assertKnown(options.modules, modules, '模块');
  const chosenModules = [...new Set(options.modules ?? modules)].sort();
  const moduleCases = entries.filter((entry) => chosenModules.includes(entry.module)).flatMap((entry) => entry.cases);
  assertKnown(options.caseIds, moduleCases.map((tc) => tc.id), '用例');
  const cases = moduleCases.filter((tc) => options.caseIds === undefined || options.caseIds.includes(tc.id));
  const missingFixtures = new Set<string>();
  for (const tc of cases) {
    if (!Object.hasOwn(profile['auth.yaml'].actors, tc.actor)) throw new ArtifactError(`用例 ${tc.id} 的 actor 角色不存在：${tc.actor}`);
    for (const fixture of tc.fixtures) if (!Object.hasOwn(profile['fixtures.yaml'].fixtures, fixture)) missingFixtures.add(fixture);
  }
  const states: VerifiedRunInputs['approvals'] = {
    profile: Object.fromEntries(PROFILE_FILES.map((name) => [name, approvals.state('profile', name, profile[name])])) as Record<ProfileFile, ApprovalState>,
    clauses: Object.fromEntries(clauses.map((clause) => [clause.id, approvals.state('clause', clause.id, clause)])),
    cases: Object.fromEntries(cases.map((tc) => [tc.id, approvals.stateCase(tc, clauses)])),
  };
  const selection = selectExecutableCases(cases, clauses, approvals);
  const input = { config, profile, clauses, cases, environment, modules: chosenModules, selection, missingFixtures: [...missingFixtures].sort(), approvals: states };
  return { ...input, fingerprint: contentHash(input) };
}
