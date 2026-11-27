import { Approvals, ArtifactStore, BudgetTracker, clauseDuplicateKey, mergeDrafts, partitionClauses } from '@crosscheck/core';
import { extractRequirements } from '@crosscheck/requirements';
import { createUsageObservationScope } from '@crosscheck/models';
import type { CliArgs } from './args';
import { createCommandUsageObserver, loadModelContext, resolveModels, withInterrupt, type CommandDependencies } from './context';
import { createDiskDocLister, createProjectReader, expandRequirementDocs, walkProject } from '@crosscheck/discovery';
import { autoNotesDocsGuidance, expandAutoNotesDocs, readRequirementDocuments, resolveRequirementEntries } from './documents';

export async function reqsCommand(args: CliArgs, log: (s: string) => void, deps: CommandDependencies = {}, signal?: AbortSignal): Promise<number> {
  const usageObservationScope = deps.usageObservationScope ?? createUsageObservationScope();
  return withInterrupt(signal, async (sig) => {
    const module = args.modules![0]!;
    const artifacts = new ArtifactStore(args.project);
    const context = await loadModelContext(artifacts, deps);
    const { config, redactor } = context;
    sig.throwIfAborted();
    const resolved = await resolveRequirementEntries(artifacts, config.requirementsDocs);
    sig.throwIfAborted();
    if (!resolved.ok) { log(resolved.message); return 2; }
    let files: string[];
    try {
      if (resolved.from === 'auto-notes') {
        const previous = new Set(resolved.allowed);
        const registered = new Set<string>();
        const walk = await walkProject(args.project, { signal: sig, onRegisteredPath: (file) => { if (previous.has(file)) registered.add(file); } });
        if (walk.diagnostics.length) throw new Error('项目扫描不完整');
        files = await expandAutoNotesDocs(args.project, resolved.entries, registered, sig);
        if (files.length !== previous.size) throw new Error('需求文档目录内容已变化');
      } else {
        files = await expandRequirementDocs(resolved.entries, createDiskDocLister(createProjectReader(args.project), (line) => log(redactor.text(line))), sig);
      }
    } catch (error) {
      sig.throwIfAborted();
      const message = error instanceof Error ? error.message : '需求文档展开失败';
      log(redactor.text(resolved.from === 'auto-notes' ? autoNotesDocsGuidance(message) : message));
      return 2;
    }
    log(`需求文档来源：${resolved.from === 'config' ? 'config.yaml' : '已确认笔记'}，共 ${files.length} 个文件`);
    let documents: Awaited<ReturnType<typeof readRequirementDocuments>>;
    try { documents = await readRequirementDocuments(args.project, files, sig); }
    catch (error) {
      if (resolved.from !== 'auto-notes') throw error;
      sig.throwIfAborted();
      log(redactor.text(autoNotesDocsGuidance(error instanceof Error ? error.message : '文档无法读取')));
      return 2;
    }
    const approvals = await Approvals.load(artifacts);
    const { approved } = partitionClauses(await artifacts.loadClauses(module), approvals);
    sig.throwIfAborted();
    const models = resolveModels(config, 'extractor', context.deps, (line) => log(redactor.text(line)));
    sig.throwIfAborted();
    const result = await extractRequirements({
      module, documents, known: approved, models,
      budget: new BudgetTracker(config.budget.perCase),
      signal: sig, resilience: deps.resilience,
      usageObserver: createCommandUsageObserver(args.project, 'reqs', 'extractor', config.pricing, deps, log), usageObservationScope,
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
  }, deps.usageObservationScope ? undefined : () => usageObservationScope.flush());
}
