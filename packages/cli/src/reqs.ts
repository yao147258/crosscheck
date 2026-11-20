import { Approvals, ArtifactStore, BudgetTracker, clauseDuplicateKey, mergeDrafts, partitionClauses } from '@crosscheck/core';
import { extractRequirements } from '@crosscheck/requirements';
import type { CliArgs } from './args';
import { loadModelContext, resolveModels, withInterrupt, type CommandDependencies } from './context';
import { createDiskDocLister, createProjectReader, expandRequirementDocs } from '@crosscheck/discovery';
import { readRequirementDocuments, resolveRequirementEntries } from './documents';

export async function reqsCommand(args: CliArgs, log: (s: string) => void, deps: CommandDependencies = {}, signal?: AbortSignal): Promise<number> {
  return withInterrupt(signal, async (sig) => {
    const module = args.modules![0]!;
    const artifacts = new ArtifactStore(args.project);
    const context = await loadModelContext(artifacts, deps);
    const { config, redactor } = context;
    sig.throwIfAborted();
    const resolved = await resolveRequirementEntries(artifacts, config.requirementsDocs);
    if (!resolved.ok) { log(resolved.message); return 2; }
    let files: string[];
    try {
      files = await expandRequirementDocs(resolved.entries, createDiskDocLister(createProjectReader(args.project), (line) => log(redactor.text(line))), sig);
    } catch (error) {
      sig.throwIfAborted();
      log(redactor.text(error instanceof Error ? error.message : '需求文档展开失败'));
      return 2;
    }
    log(`需求文档来源：${resolved.from === 'config' ? 'config.yaml' : '已确认笔记'}，共 ${files.length} 个文件`);
    const documents = await readRequirementDocuments(args.project, files, sig);
    const approvals = await Approvals.load(artifacts);
    const { approved } = partitionClauses(await artifacts.loadClauses(module), approvals);
    sig.throwIfAborted();
    const models = resolveModels(config, 'extractor', context.deps, (line) => log(redactor.text(line)));
    sig.throwIfAborted();
    const result = await extractRequirements({
      module, documents, known: approved, models,
      budget: new BudgetTracker(config.budget.perCase),
      signal: sig, resilience: deps.resilience,
    }).catch((error: unknown) => { throw new Error(redactor.text(error instanceof Error ? error.message : '模型调用失败')); });
    sig.throwIfAborted();
    if (result.status !== 'done') { log(redactor.text(`提炼未完成（${result.reason}）：${result.detail}；未修改条款文件`)); return 2; }
    const merged = mergeDrafts(approved, redactor.value(result.output), clauseDuplicateKey);
    sig.throwIfAborted();
    await artifacts.saveClauses(module, merged.items);
    sig.throwIfAborted();
    for (const dropped of merged.dropped) log(redactor.text(`丢弃草稿 ${dropped.id}：${dropped.reason}`));
    log(`模块 ${module}：保留已确认 ${merged.kept} 条，写入草稿 ${merged.added} 条；请运行 crosscheck review clauses --module ${module} 审核`);
    return 0;
  });
}
