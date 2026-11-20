import { Approvals, ArtifactStore, BudgetTracker, decodeNotesUtf8, NotesTextSchema, ProjectConfigSchema } from '@crosscheck/core';
import { synthesizeNotes, walkProject } from '@crosscheck/discovery';
import { sanitizeMultiline } from '@crosscheck/discovery/sanitize';
import type { CliArgs } from './args';
import { loadModelContext, resolveModels, withCliProgress, withInterrupt, type CommandDependencies } from './context';

export const NOTES_FILE = 'notes.md';
export const CONFIG_TEMPLATE = {
  budget: { perCase: { steps: 60, tokens: 400000, minutes: 10 } },
  requirementsDocs: [] as string[],
};

export async function initCommand(args: CliArgs, log: (s: string) => void, deps: CommandDependencies = {}, signal?: AbortSignal): Promise<number> {
  return withInterrupt(signal, async (sig) => {
    const artifacts = new ArtifactStore(args.project);
    const projectConfig = await artifacts.readYaml('config.yaml', ProjectConfigSchema);
    sig.throwIfAborted();
    if (!projectConfig) {
      await artifacts.writeYaml('config.yaml', CONFIG_TEMPLATE);
      log('已写入 .crosscheck/config.yaml 默认配置（可按需修改），继续扫描项目');
      sig.throwIfAborted();
    }
    const approvals = await Approvals.load(artifacts);
    const original = await artifacts.readBytes(NOTES_FILE);
    let existing: string | undefined;
    try { existing = original === undefined ? undefined : decodeNotesUtf8(original); }
    catch { log('notes.md 不是有效的 UTF-8，请修复后重试'); return 2; }
    sig.throwIfAborted();
    if (existing !== undefined && approvals.state('notes', 'project', existing) === 'approved' && !args.refresh) {
      log('项目笔记已确认，跳过生成（需要更新时使用 --refresh）');
      return 0;
    }
    if (args.refresh && existing !== undefined && !NotesTextSchema.safeParse(existing).success) {
      log('旧笔记格式不合法或超过大小限制，请修复后刷新'); return 2;
    }
    const context = await loadModelContext(artifacts, deps);
    const { config, redactor } = context;
    const walk = await walkProject(args.project, { signal: sig });
    for (const diagnostic of walk.diagnostics) log(redactor.text(`扫描诊断：${diagnostic}`));
    log(`登记文件 ${walk.files.length} 个，由模型按需读取`);
    sig.throwIfAborted();
    const models = resolveModels(config, 'extractor', context.deps, (line) => log(redactor.text(line)));
    const result = await withCliProgress((line) => log(redactor.text(line)), () => synthesizeNotes({
      projectRoot: args.project, files: walk.files, diagnostics: walk.diagnostics.map((line) => redactor.text(line)),
      previous: args.refresh && existing !== undefined ? redactor.text(existing) : undefined,
      clean: (text) => redactor.text(text),
      models, budget: () => new BudgetTracker(config.budget.discovery), signal: sig, resilience: deps.resilience,
    })).catch((error: unknown) => {
      if (sig.aborted && (error === sig.reason || error instanceof Error && error.name === 'AbortError')) throw error;
      throw new Error(redactor.text(error instanceof Error ? error.message : '模型调用失败'));
    });
    sig.throwIfAborted();
    if (result.status !== 'done') {
      log(redactor.text(`笔记生成失败：${result.detail}`));
      if (result.reason === 'budget') log('可在 .crosscheck/config.yaml 的 budget.discovery 中调大扫描预算');
      return 2;
    }
    const text = redactor.text(sanitizeMultiline(result.text));
    if (!NotesTextSchema.safeParse(text).success) { log('脱敏后的笔记格式不合法，未写入'); return 2; }
    const current = await artifacts.readBytes(NOTES_FILE);
    sig.throwIfAborted();
    if (original === undefined ? current !== undefined : current === undefined || !original.equals(current)) {
      log('项目笔记在生成期间发生修改，未覆盖；请重试'); return 2;
    }
    const latestApprovals = await Approvals.load(artifacts);
    if (JSON.stringify(latestApprovals.record('notes', 'project')) !== JSON.stringify(approvals.record('notes', 'project'))) {
      log('笔记审核记录在生成期间发生变化，未覆盖；请重试'); return 2;
    }
    sig.throwIfAborted();
    await artifacts.writeBytes(NOTES_FILE, Buffer.from(text));
    sig.throwIfAborted();
    log('项目笔记草稿已写入 .crosscheck/notes.md，请运行 crosscheck review notes 审核');
    return 0;
  });
}
