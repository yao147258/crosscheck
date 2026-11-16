import { Approvals, ArtifactStore, BudgetTracker, clauseDuplicateKey, mergeDrafts, partitionClauses } from '@crosscheck/core';
import { extractRequirements } from '@crosscheck/requirements';
import type { CliArgs } from './args';
import { resolveModels, withInterrupt, type CommandDependencies } from './context';
import { readRequirementDocuments } from './documents';

export async function reqsCommand(args: CliArgs, log: (s: string) => void, deps: CommandDependencies = {}, signal?: AbortSignal): Promise<number> {
  return withInterrupt(signal, async (sig) => {
    const module = args.modules![0]!;
    const artifacts = new ArtifactStore(args.project);
    const config = await artifacts.loadConfig();
    sig.throwIfAborted();
    if (config.requirementsDocs.length === 0) { log('config.yaml 的 requirementsDocs 为空，请先登记需求文档'); return 2; }
    const documents = await readRequirementDocuments(args.project, config.requirementsDocs, sig);
    const approvals = await Approvals.load(artifacts);
    const { approved } = partitionClauses(await artifacts.loadClauses(module), approvals);
    sig.throwIfAborted();
    const models = resolveModels(config, 'extractor', deps, log);
    sig.throwIfAborted();
    const result = await extractRequirements({
      module, documents, known: approved, models,
      budget: new BudgetTracker(config.budget.perCase),
      signal: sig, resilience: deps.resilience,
    });
    sig.throwIfAborted();
    if (result.status !== 'done') { log(`提炼未完成（${result.reason}）：${result.detail}；未修改条款文件`); return 2; }
    const merged = mergeDrafts(approved, result.output, clauseDuplicateKey);
    sig.throwIfAborted();
    await artifacts.saveClauses(module, merged.items);
    sig.throwIfAborted();
    for (const dropped of merged.dropped) log(`丢弃草稿 ${dropped.id}：${dropped.reason}`);
    log(`模块 ${module}：保留已确认 ${merged.kept} 条，写入草稿 ${merged.added} 条；请运行 crosscheck review clauses --module ${module} 审核`);
    return 0;
  });
}
