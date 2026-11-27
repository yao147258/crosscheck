import { AUTO_REVIEWER, Approvals, ArtifactError, ArtifactStore, BudgetTracker, contentHash, decodeNotesUtf8, loadProfile, NotesTextSchema, parseNotesRequirementDocs, PROFILE_FILES, PROFILE_SCHEMAS, ProjectConfigSchema, readProfileFiles, type Profile, type ProfileFile } from '@crosscheck/core';
import { normalizeSafeProjectPath, synthesizeNotes, verifyEntrySources, walkProject } from '@crosscheck/discovery';
import { sanitizeMultiline } from '@crosscheck/discovery/sanitize';
import YAML from 'yaml';
import type { CliArgs } from './args';
import { loadModelContext, resolveModels, withCliProgress, withInterrupt, type CommandDependencies } from './context';
import { autoNotesDocsGuidance, expandAutoNotesDocs, NOTES_DISCOVERY_FILE } from './documents';
import { NOTES_FILE } from './notes-path';
import { profileCommand } from './profile';
import { reviewCommand } from './review';

export { NOTES_FILE } from './notes-path';
export const CONFIG_TEMPLATE = {
  budget: { perCase: { steps: 60, tokens: 400000, minutes: 10 } },
  requirementsDocs: [] as string[],
};

type Logger = (s: string) => void;

export async function initCommand(args: CliArgs, log: Logger, deps: CommandDependencies = {}, signal?: AbortSignal): Promise<number> {
  return withInterrupt(signal, async (sig) => {
    const artifacts = new ArtifactStore(args.project);
    const projectConfig = await artifacts.readYaml('config.yaml', ProjectConfigSchema);
    sig.throwIfAborted();
    if (!projectConfig) {
      await artifacts.writeYaml('config.yaml', CONFIG_TEMPLATE);
      sig.throwIfAborted();
      log('已写入 .crosscheck/config.yaml 默认配置（可按需修改），继续扫描项目');
    }
    const notesCode = await generateNotes(args, log, deps, sig, artifacts);
    if (notesCode !== 0) return notesCode;
    sig.throwIfAborted();
    if (!args.refresh && !(await pendingProfiles(artifacts, sig)).length) return finishConfirmed(artifacts, sig, log);
    const profileCode = await profileCommand(args, log, deps, sig);
    if (profileCode !== 0) return profileCode;
    sig.throwIfAborted();
    await autoApproveVerified(args, log, deps, sig, artifacts);
    return handOffReview(args, log, deps, sig, artifacts);
  });
}

function sameBytes(expected: Buffer | undefined, current: Buffer | undefined): boolean {
  return expected === undefined ? current === undefined : current !== undefined && expected.equals(current);
}

/** 重新读取目标和审核记录；只在两者仍匹配时返回最新审核表，避免覆盖并发人工确认。 */
async function unchangedApprovals(
  artifacts: ArtifactStore, rel: string, expected: Buffer | undefined, baseline: Approvals,
  kind: 'notes' | 'profile', id: string, sig: AbortSignal,
): Promise<Approvals | undefined> {
  const record = JSON.stringify(baseline.record(kind, id));
  let latest = baseline;
  // 固定三轮对照同一基线，而非有变化就重试。任一轮不一致即停止；这不是原子比较与交换。
  for (let pass = 0; pass < 3; pass++) {
    const current = await artifacts.readBytes(rel);
    sig.throwIfAborted();
    if (!sameBytes(expected, current)) return undefined;
    latest = await Approvals.load(artifacts);
    sig.throwIfAborted();
    if (JSON.stringify(latest.record(kind, id)) !== record) return undefined;
  }
  return latest;
}

async function generateNotes(args: CliArgs, log: Logger, deps: CommandDependencies, sig: AbortSignal, artifacts: ArtifactStore): Promise<number> {
  const approvals = await Approvals.load(artifacts);
  sig.throwIfAborted();
  const original = await artifacts.readBytes(NOTES_FILE);
  sig.throwIfAborted();
  let existing: string | undefined;
  try { existing = original === undefined ? undefined : decodeNotesUtf8(original); }
  catch { log('notes.md 不是有效的 UTF-8，请修复后重试'); return 2; }
  if (existing !== undefined && approvals.state('notes', 'project', existing) === 'approved' && !args.refresh) {
    log('项目笔记已确认，跳过生成（需要更新时使用 --refresh）');
    return 0;
  }
  if (args.refresh && existing !== undefined && !NotesTextSchema.safeParse(existing).success) {
    log('旧笔记格式不合法或超过大小限制，请修复后刷新'); return 2;
  }
  const context = await loadModelContext(artifacts, deps);
  sig.throwIfAborted();
  const { config, redactor } = context;
  const registered = new Set<string>();
  const walk = await walkProject(args.project, { signal: sig, onRegisteredPath: (file) => registered.add(file) });
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
  const bytes = Buffer.from(text);
  if (decodeNotesUtf8(bytes) !== text) { log('生成的笔记无法无损编码为 UTF-8，未写入'); return 2; }
  const entries = parseNotesRequirementDocs(text);
  let registeredDocs: string[] = [];
  if (entries.length) {
    try {
      if (walk.diagnostics.length) throw new Error('项目扫描不完整');
      registeredDocs = await expandAutoNotesDocs(args.project, entries, registered, sig);
    } catch (error) {
      sig.throwIfAborted();
      log(redactor.text(autoNotesDocsGuidance(error instanceof Error ? error.message : '文档范围不可判定')));
    }
  }
  if (!await unchangedApprovals(artifacts, NOTES_FILE, original, approvals, 'notes', 'project', sig)) {
    log('项目笔记或审核记录在生成期间发生变化，未覆盖；请重试'); return 2;
  }
  sig.throwIfAborted();
  await artifacts.writeBytes(NOTES_FILE, bytes);
  sig.throwIfAborted();
  if (entries.length) {
    // 只记录本次笔记列出的、真实登记的路径，不记录正文。先写宿主记录再签署笔记；不匹配时 reqs 拒绝。
    await artifacts.writeJson(NOTES_DISCOVERY_FILE, { hash: contentHash(text), files: registeredDocs });
    sig.throwIfAborted();
  }
  const latest = await unchangedApprovals(artifacts, NOTES_FILE, bytes, approvals, 'notes', 'project', sig);
  if (!latest) { log('项目笔记或审核记录在写入后发生变化，跳过自动确认；请重试'); return 2; }
  latest.approve('notes', 'project', text, AUTO_REVIEWER);
  sig.throwIfAborted();
  await latest.save(artifacts);
  sig.throwIfAborted();
  log('项目笔记已写入 .crosscheck/notes.md 并自动确认（确认人 auto）');
  return 0;
}

type VerifiableProfile = 'api-catalog.yaml' | 'pages.yaml';

function parseSnapshot<Name extends VerifiableProfile>(name: Name, bytes: Buffer): Profile[Name] | undefined {
  let raw: unknown;
  try { raw = YAML.parse(bytes.toString('utf8')); }
  catch { return undefined; }
  const parsed = PROFILE_SCHEMAS[name].safeParse(raw);
  return parsed.success ? parsed.data as Profile[Name] : undefined;
}

/** 只核验两份带来源的画像；画像值直接由待比较的同一份字节快照解析。 */
async function autoApproveVerified(args: CliArgs, log: Logger, deps: CommandDependencies, sig: AbortSignal, artifacts: ArtifactStore): Promise<void> {
  async function loadVerificationContext() {
    const { redactor } = await loadModelContext(artifacts, deps);
    sig.throwIfAborted();
    const { files } = await walkProject(args.project, { signal: sig });
    sig.throwIfAborted();
    return { redactor, files };
  }
  let context: Awaited<ReturnType<typeof loadVerificationContext>> | undefined;
  for (const name of ['api-catalog.yaml', 'pages.yaml'] as const) {
    const rel = `system/${name}`;
    const snapshot = await artifacts.readBytes(rel);
    sig.throwIfAborted();
    if (!snapshot) continue;
    const value = parseSnapshot(name, snapshot);
    if (!value) continue;
    const baseline = await Approvals.load(artifacts);
    sig.throwIfAborted();
    if (baseline.state('profile', name, value) === 'approved') continue;
    context ??= await loadVerificationContext();
    const { files, redactor } = context;
    const entries = 'operations' in value ? value.operations : value.pages;
    const unlistedExplicit = new Set((args.openapi ?? []).map(normalizeSafeProjectPath)
      .filter((file): file is string => !!file && !files.some((entry) => entry.path === file)));
    if (Object.values(entries).some((entry) => entry.sources.some(({ file }) => {
      const normalized = normalizeSafeProjectPath(file);
      return normalized !== undefined && unlistedExplicit.has(normalized);
    }))) {
      log(`${name} 引用的显式 --openapi 文件未登记，保留原稿并交由人工审核`);
      continue;
    }
    const { kept, dropped, unreadable } = await verifyEntrySources({
      projectRoot: args.project, files, entries, clean: (text) => redactor.text(text),
      normalize: (line) => redactor.value(line), signal: sig,
    });
    sig.throwIfAborted();
    if (unreadable.length) {
      log(redactor.text(`${name} 无法读取来源：${unreadable.join('、')}；保留原稿，请排查后重试或进行人工审核`));
      continue;
    }
    const count = Object.keys(kept).length;
    if (!count) {
      for (const { name: entry, reason } of dropped) log(redactor.text(`${name} 条目 ${entry} 未通过核验（${reason}）`));
      log(`${name} 没有通过来源核验的条目，保留原文件并交由人工审核`);
      continue;
    }
    const changed = () => log(`${name} 的文件或审核记录在核验或写入期间发生变化，跳过自动确认`);
    let latest = await unchangedApprovals(artifacts, rel, snapshot, baseline, 'profile', name, sig);
    if (!latest) { changed(); continue; }
    let approved = value;
    if (dropped.length) {
      const filtered = 'operations' in value ? { ...value, operations: kept } : { ...value, pages: kept };
      const bytes = Buffer.from(YAML.stringify(filtered, { lineWidth: 0 }));
      // 从预期写入的内容计算签名；重读只用于比较，不用磁盘上未经核验的新载荷替换它。
      const expected = parseSnapshot(name, bytes);
      if (!expected) { log(`${name} 剔除后格式不合法，保留原文件并交由人工审核`); continue; }
      sig.throwIfAborted();
      await artifacts.writeBytes(rel, bytes);
      sig.throwIfAborted();
      latest = await unchangedApprovals(artifacts, rel, bytes, baseline, 'profile', name, sig);
      if (!latest) { changed(); continue; }
      approved = expected;
    }
    latest.approve('profile', name, approved, AUTO_REVIEWER);
    sig.throwIfAborted();
    await latest.save(artifacts);
    sig.throwIfAborted();
    for (const { name: entry, reason } of dropped) log(redactor.text(`核验未通过，已从 ${name} 剔除 ${entry}（${reason}）`));
    log(`${name} 已自动确认（确认人 auto），保留 ${count} 条${dropped.length ? `，剔除 ${dropped.length} 条` : ''}`);
  }
}

async function pendingProfiles(artifacts: ArtifactStore, sig: AbortSignal): Promise<ProfileFile[]> {
  const approvals = await Approvals.load(artifacts);
  sig.throwIfAborted();
  const files = await readProfileFiles(artifacts);
  sig.throwIfAborted();
  return files.filter((file) => !file.present || !file.ok || approvals.state('profile', file.name, file.value) !== 'approved').map((file) => file.name);
}

async function finishConfirmed(artifacts: ArtifactStore, sig: AbortSignal, log: Logger): Promise<number> {
  const bytes = await artifacts.readBytes(NOTES_FILE);
  sig.throwIfAborted();
  let text: string | undefined;
  try { text = bytes === undefined ? undefined : decodeNotesUtf8(bytes); }
  catch { log('notes.md 不是有效的 UTF-8，请修复后重新审核'); return 2; }
  const approvals = await Approvals.load(artifacts);
  sig.throwIfAborted();
  if (text === undefined || approvals.state('notes', 'project', text) !== 'approved') {
    log('项目笔记尚未确认或确认已失效；请重新确认后继续');
    return 2;
  }
  let profile: Profile;
  try { profile = await loadProfile(artifacts); }
  catch (error) {
    // 与 plan 相同：缺失或结构校验才是可修复的输入问题，真实存储异常继续向上抛出。
    if (error instanceof ArtifactError && (error.message.startsWith('缺少必需系统画像：') || error.message.startsWith('系统画像不合法：'))) {
      sig.throwIfAborted();
      log(error.message);
      return 2;
    }
    throw error;
  }
  sig.throwIfAborted();
  // 使用通过交叉校验的同一份载荷复核确认，避免结束前校验过了不同版本。
  const latest = await unchangedApprovals(artifacts, NOTES_FILE, bytes, approvals, 'notes', 'project', sig);
  if (!latest) {
    log('项目笔记尚未确认或确认已失效，或在结束检查期间发生变化；请重新确认后继续');
    return 2;
  }
  const unapproved = PROFILE_FILES.filter((name) => latest.state('profile', name, profile[name]) !== 'approved');
  if (unapproved.length) { log(`系统画像尚未确认或确认已失效：${unapproved.join('、')}`); return 2; }
  log('笔记与七份画像均已确认');
  return 0;
}

async function handOffReview(args: CliArgs, log: Logger, deps: CommandDependencies, sig: AbortSignal, artifacts: ArtifactStore): Promise<number> {
  const pending = await pendingProfiles(artifacts, sig);
  if (!pending.length) return finishConfirmed(artifacts, sig, log);
  log(`以下画像需要人工确认：${pending.join('、')}`);
  sig.throwIfAborted();
  if (deps.init?.deferReview) { deps.init.deferReview(pending); return 0; }
  if (!(deps.review?.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    log('当前不是交互式终端，请在交互式终端运行 crosscheck review profile 完成确认');
    return 2;
  }
  const code = await reviewCommand({ ...args, command: 'review', view: 'profile', only: pending }, log, deps, sig);
  const left = await pendingProfiles(artifacts, sig);
  if (left.length) log(`仍有 ${left.length} 份画像未确认：${left.join('、')}；可运行 crosscheck review profile 继续`);
  else if (code === 0) return finishConfirmed(artifacts, sig, log);
  return code;
}
