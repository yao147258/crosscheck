import {
  Approvals, ArtifactError, ArtifactStore, BudgetTracker,
  assertStoredProfileApproved, coverage, loadCoveredClauses, mergeDrafts, partitionCases, selectPlannableClauses,
  type Profile,
} from '@crosscheck/core';
import { generateCases } from '@crosscheck/planner';
import type { CliArgs } from './args';
import { resolveModels, withInterrupt, type CommandDependencies } from './context';

export async function planCommand(args: CliArgs, log: (s: string) => void, deps: CommandDependencies = {}, signal?: AbortSignal): Promise<number> {
  return withInterrupt(signal, async (sig) => {
    const module = args.modules![0]!;
    const artifacts = new ArtifactStore(args.project);
    const config = await artifacts.loadConfig();
    const approvals = await Approvals.load(artifacts);
    sig.throwIfAborted();
    let profile: Profile;
    try {
      profile = await assertStoredProfileApproved(artifacts, approvals);
    } catch (error) {
      // ArtifactError 同时包含存储错误；只把 loadProfile 的缺失/结构校验诊断视为门禁。
      if (error instanceof ArtifactError && (error.message.startsWith('缺少必需系统画像：') || error.message.startsWith('系统画像不合法：'))) {
        log(error.message);
        return 2;
      }
      throw error;
    }
    sig.throwIfAborted();
    const clauses = await artifacts.loadClauses(module);
    sig.throwIfAborted();
    const ready = selectPlannableClauses(clauses, approvals).ready;
    if (ready.length === 0) { log(`模块 ${module} 没有已确认且 active 的条款`); return 2; }
    const cases = await artifacts.loadCases(module);
    const { approved } = partitionCases(cases, await loadCoveredClauses(artifacts, cases), approvals);
    sig.throwIfAborted();
    const models = resolveModels(config, 'planner', deps, log);
    sig.throwIfAborted();
    const result = await generateCases({
      module, clauses: ready, approvals, profile, knownCases: approved, models,
      budget: new BudgetTracker(config.budget.perCase),
      signal: sig, resilience: deps.resilience,
    });
    sig.throwIfAborted();
    if (result.status !== 'done') { log(`用例生成未完成（${result.reason}）：${result.detail}；未修改用例文件`); return 2; }
    const merged = mergeDrafts(approved, result.output);
    sig.throwIfAborted();
    await artifacts.saveCases(module, merged.items);
    sig.throwIfAborted();
    for (const dropped of merged.dropped) log(`丢弃草稿 ${dropped.id}：${dropped.reason}`);
    const cov = coverage(ready, merged.items);
    log(`模块 ${module}：保留已确认 ${merged.kept} 个，写入草稿 ${merged.added} 个；条款覆盖 ${cov.covered.length}/${ready.length}`);
    if (cov.uncovered.length) log(`未覆盖条款：${cov.uncovered.join(', ')}`);
    log(`请运行 crosscheck review cases --module ${module} 审核`);
    return 0;
  });
}
