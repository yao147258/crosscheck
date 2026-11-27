import path from 'node:path';
import { AUTO_REVIEWER, Approvals, contentHash, decodeNotesUtf8, parseNotesRequirementDocs, type ArtifactStore } from '@crosscheck/core';
import { createDiskDocLister, createProjectReader, expandRequirementDocs, isSafeProjectPath } from '@crosscheck/discovery';
import { z } from 'zod';
import type { RequirementDocument } from '@crosscheck/requirements';

/** 使用项目安全读取器拒绝链接、凭证和超大文件，来源统一为正斜线相对路径。 */
export async function readRequirementDocuments(projectRoot: string, files: string[], signal?: AbortSignal): Promise<RequirementDocument[]> {
  const reader = createProjectReader(projectRoot);
  const documents: RequirementDocument[] = [];
  let totalBytes = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    // 先校验原路径，不能通过规范化抹掉父路径或凭证路径组件。
    // 单次限额读取先保留真实宿主错误，避免读取器用同时发生的取消覆盖它。
    const text = await reader.readText(file);
    signal?.throwIfAborted();
    if (text === undefined) throw new Error(`需求文档不存在：${file}`);
    totalBytes += Buffer.byteLength(text, 'utf8');
    if (totalBytes > 2 * 1024 * 1024) throw new Error('需求文档总大小超出 2 MiB 限制');
    documents.push({ file: path.posix.normalize(file.replaceAll('\\', '/')), text });
  }
  return documents;
}

export const NOTES_DISCOVERY_FILE = 'notes-discovery.json';
const NotesDiscoverySchema = z.strictObject({ hash: z.string(), files: z.array(z.string()) });
export const autoNotesDocsGuidance = (reason: string) => `自动确认笔记的需求文档无法安全展开：${reason}；请在 config.yaml 的 requirementsDocs 显式登记，或人工审核笔记后运行 crosscheck review notes 确认`;

/** 不读取正文：先完整展开，再检查每个候选文件均在宿主登记范围。 */
export async function expandAutoNotesDocs(projectRoot: string, entries: string[], registered: ReadonlySet<string>, signal?: AbortSignal): Promise<string[]> {
  const files = await expandRequirementDocs(entries, createDiskDocLister(createProjectReader(projectRoot), undefined, { strict: true }), signal);
  if (files.some((file) => !isSafeProjectPath(file) || !registered.has(file))) throw new Error('存在不安全或未登记的候选文件');
  return files;
}

export type RequirementEntries =
  | { ok: true; entries: string[]; from: 'config' | 'notes' }
  | { ok: true; entries: string[]; from: 'auto-notes'; allowed: string[] }
  | { ok: false; message: string };

const NOT_REGISTERED = 'requirementsDocs 为空：请在 config.yaml 的 requirementsDocs 登记需求文档，或在 notes.md 的“需求文档”小节登记并运行 crosscheck review notes 确认';

/** config 的 requirementsDocs 非空时优先；否则读取已确认笔记的“需求文档”小节。 */
export async function resolveRequirementEntries(artifacts: ArtifactStore, configured: string[]): Promise<RequirementEntries> {
  if (configured.length > 0) return { ok: true, entries: configured, from: 'config' };
  const bytes = await artifacts.readBytes('notes.md');
  if (bytes === undefined) return { ok: false, message: NOT_REGISTERED };
  let text: string;
  try { text = decodeNotesUtf8(bytes); }
  catch { return { ok: false, message: 'notes.md 不是有效的 UTF-8，请修复后重试' }; }
  const entries = parseNotesRequirementDocs(text);
  if (entries.length === 0) return { ok: false, message: NOT_REGISTERED };
  const approvals = await Approvals.load(artifacts);
  if (approvals.state('notes', 'project', text) !== 'approved') {
    return { ok: false, message: 'notes.md 的“需求文档”小节尚未确认：请先运行 crosscheck review notes 审核并确认笔记' };
  }
  if (approvals.record('notes', 'project')?.by === AUTO_REVIEWER) {
    let discovery: z.infer<typeof NotesDiscoverySchema> | undefined;
    try { discovery = await artifacts.readJson(NOTES_DISCOVERY_FILE, NotesDiscoverySchema); }
    catch { return { ok: false, message: autoNotesDocsGuidance('无法读取宿主登记记录') }; }
    if (!discovery || discovery.hash !== contentHash(text)) {
      return { ok: false, message: autoNotesDocsGuidance('缺少与当前笔记匹配的宿主登记记录') };
    }
    return { ok: true, entries, from: 'auto-notes', allowed: discovery.files };
  }
  return { ok: true, entries, from: 'notes' };
}
