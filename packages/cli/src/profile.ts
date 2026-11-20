import { Approvals, ArtifactStore, BudgetTracker, decodeNotesUtf8, PROFILE_FILES, PROFILE_SCHEMAS, ProjectConfigSchema, readProfileFiles, type ProfileFile } from '@crosscheck/core';
import { discover, exploreProject, openApiPlugin, staticScanPlugin, synthesizeProfile, walkProject, type DiscoveryFact } from '@crosscheck/discovery';
import { sanitizeContext } from '@crosscheck/discovery/sanitize';
import { NOTES_FILE } from './init';
import type { CliArgs } from './args';
import { loadModelContext, resolveModels, withCliProgress, withInterrupt, type CommandDependencies } from './context';

export const DEFAULT_OPENAPI_FILES = [
  'openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json',
  'docs/openapi.yaml', 'docs/openapi.json', 'api/openapi.yaml',
];

export async function profileCommand(args: CliArgs, log: (s: string) => void, deps: CommandDependencies = {}, signal?: AbortSignal): Promise<number> {
  return withInterrupt(signal, async (sig) => {
    const artifacts = new ArtifactStore(args.project);
    const projectConfig = await artifacts.readYaml('config.yaml', ProjectConfigSchema);
    sig.throwIfAborted();
    if (!projectConfig) {
      log('缺少 .crosscheck/config.yaml，请先运行 crosscheck init');
      return 2;
    }
    const approvals = await Approvals.load(artifacts);
    const notesBytes = await artifacts.readBytes(NOTES_FILE);
    let notes: string | undefined;
    try { notes = notesBytes === undefined ? undefined : decodeNotesUtf8(notesBytes); }
    catch { log('notes.md 不是有效的 UTF-8，请修复后重新审核'); return 2; }
    sig.throwIfAborted();
    if (notes === undefined || approvals.state('notes', 'project', notes) !== 'approved') {
      log('项目笔记尚未确认，请先运行 crosscheck init 和 crosscheck review notes');
      return 2;
    }
    const context = await loadModelContext(artifacts, deps);
    const { config, redactor } = context;
    const scan = await discover({ projectRoot: args.project, plugins: [staticScanPlugin, openApiPlugin(args.openapi ?? DEFAULT_OPENAPI_FILES)], signal: sig });
    log(`发现事实 ${scan.facts.length} 条`);
    for (const d of scan.diagnostics) log(redactor.text(`诊断 [${d.plugin}]${d.file ? ` ${d.file}` : ''}：${d.message}`));

    const existing: Partial<Record<ProfileFile, unknown>> = {};
    const snapshots = new Map<ProfileFile, Buffer | undefined>();
    for (const name of PROFILE_FILES) snapshots.set(name, await artifacts.readBytes(`system/${name}`));
    const files = await readProfileFiles(artifacts);
    for (const file of files) {
      if (file.present && file.ok && approvals.state('profile', file.name, file.value) === 'approved') existing[file.name] = file.value;
    }
    sig.throwIfAborted();
    const models = resolveModels(config, 'extractor', context.deps, (line) => log(redactor.text(line)));
    sig.throwIfAborted();
    // 全部画像已确认时无需探索，不调用模型。
    const explored: DiscoveryFact[] = [];
    if (PROFILE_FILES.some((name) => !Object.hasOwn(existing, name))) {
      const walk = await walkProject(args.project, { signal: sig });
      const outcome = await withCliProgress((line) => log(redactor.text(line)), () => exploreProject({
        projectRoot: args.project, files: walk.files, facts: redactor.value(scan.facts), notes: redactor.text(notes),
        clean: (text) => redactor.text(text), models, budget: () => new BudgetTracker(config.budget.discovery),
        signal: sig, resilience: deps.resilience,
      })).catch((error: unknown) => {
        if (sig.aborted) throw error;
        return { status: 'failed' as const, reason: 'model-error', detail: error instanceof Error ? error.message : '探索失败', interrupted: false };
      });
      sig.throwIfAborted();
      if (outcome.status === 'done') {
        for (const line of outcome.diagnostics) log(redactor.text(line));
        log(`模型探索新增事实 ${outcome.facts.length} 条`);
        explored.push(...outcome.facts);
      } else {
        log(redactor.text(`模型探索未完成（${outcome.reason}）：${outcome.detail}；仅使用静态扫描事实`));
      }
    }
    const result = await synthesizeProfile({
      facts: redactor.value([...scan.facts, ...explored]),
      notes: redactor.text(notes),
      existing: sanitizeContext(redactor.value(existing)),
      cleanContext: (value) => redactor.value(value),
      models,
      budget: () => new BudgetTracker(config.budget.perCase),
      signal: sig,
      resilience: deps.resilience,
    }).catch((error: unknown) => { throw new Error(redactor.text(error instanceof Error ? error.message : '模型调用失败')); });
    sig.throwIfAborted();
    let invalid = false;
    const written = new Set<string>();
    for (const [name, value] of Object.entries(result.generated)) {
      sig.throwIfAborted();
      const currentNotes = await artifacts.readBytes(NOTES_FILE);
      const latestContextApprovals = await Approvals.load(artifacts);
      if (!currentNotes || !notesBytes || !currentNotes.equals(notesBytes) ||
          JSON.stringify(latestContextApprovals.record('notes', 'project')) !== JSON.stringify(approvals.record('notes', 'project'))) {
        log('笔记内容或审核记录已改变，停止写入画像；请重试'); return 2;
      }
      for (const contextName of Object.keys(existing) as ProfileFile[]) {
        const previous = snapshots.get(contextName);
        const now = await artifacts.readBytes(`system/${contextName}`);
        if (!previous || !now || !previous.equals(now) ||
            JSON.stringify(latestContextApprovals.record('profile', contextName)) !== JSON.stringify(approvals.record('profile', contextName))) {
          log(`已确认画像 ${contextName} 或其审核记录已改变，停止写入；请重试`); return 2;
        }
      }
      const cleaned = redactor.value(value);
      if (!PROFILE_SCHEMAS[name as ProfileFile].safeParse(cleaned).success) {
        log(`画像 ${name} 脱敏后格式不合法，未写入`); invalid = true; continue;
      }
      const prior = snapshots.get(name as ProfileFile);
      const current = await artifacts.readBytes(`system/${name}`);
      const latestApprovals = await Approvals.load(artifacts);
      if ((prior === undefined ? current !== undefined : current === undefined || !prior.equals(current)) ||
          JSON.stringify(latestApprovals.record('profile', name)) !== JSON.stringify(approvals.record('profile', name))) {
        log(`画像 ${name} 在生成期间被修改或审核，停止写入；请重试`); return 2;
      }
      sig.throwIfAborted();
      await artifacts.writeYaml(`system/${name}`, cleaned);
      written.add(name);
    }
    sig.throwIfAborted();
    for (const step of result.steps) {
      const files = step.files.join('、');
      if (step.status === 'generated') {
        const saved = step.files.filter((name) => written.has(name));
        if (saved.length) log(`已生成 ${saved.join('、')}`);
      }
      else if (step.status === 'skipped') log(`跳过（已确认）${files}`);
      else log(redactor.text(`生成失败 ${files}：${step.detail ?? ''}`));
    }
    for (const issue of result.crossCheck) log(redactor.text(`交叉校验：${issue}`));
    if (written.size) log(`已写入 ${written.size} 份画像草稿到 .crosscheck/system/，请运行 crosscheck review profile 审核`);
    else log('本次未写入画像草稿');
    return invalid || result.interrupted || result.steps.some((s) => s.status === 'failed') ? 2 : 0;
  });
}
