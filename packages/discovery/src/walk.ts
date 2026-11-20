import { createProjectReader, isCredential } from './files';
import { sanitize } from './sanitize';

export const WALK_LIMITS = { maxFiles: 2000, maxDirectories: 2000, maxEntries: 10000, maxDepth: 32 } as const;
export const DEFAULT_IGNORES = ['node_modules', '.git', '.crosscheck', 'dist', 'build', 'out', 'coverage', '.next', 'target', 'venv', '.venv', '__pycache__', '.idea', '.vscode'];

/** path 为已脱敏的相对路径；内容由模型通过只读工具按需读取。 */
export interface FileEntry { path: string; bytes: number }
export interface WalkResult { files: FileEntry[]; diagnostics: string[] }

/** 仅实现名称、路径前缀、星号和根锚定的有限子集，并非完整 Git 语义；忽略取反规则。默认 Windows 不区分大小写，其他平台区分。 */
export function parseGitignore(text: string, options: { caseSensitive?: boolean } = {}): (relative: string, isDirectory: boolean) => boolean {
  const flags = (options.caseSensitive ?? process.platform !== 'win32') ? '' : 'i';
  const rules = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('!')).map((line) => ({
    anchored: line.startsWith('/'), directoryOnly: line.endsWith('/'),
    segments: line.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map((part) => new RegExp(`^${part.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`, flags)),
  })).filter((rule) => rule.segments.length > 0);
  return (relative, isDirectory) => {
    const parts = relative.split('/');
    return rules.some((rule) => (rule.anchored ? [0] : parts.map((_, index) => index)).some((start) => {
      const end = start + rule.segments.length;
      return end <= parts.length && rule.segments.every((pattern, i) => pattern.test(parts[start + i]!)) &&
        (!rule.directoryOnly || end < parts.length || isDirectory);
    }));
  };
}

export async function walkProject(projectRoot: string, options: { maxFiles?: number; maxDirectories?: number; maxEntries?: number; maxDepth?: number; signal?: AbortSignal } = {}): Promise<WalkResult> {
  const limits = { ...WALK_LIMITS, ...options };
  for (const value of [limits.maxFiles, limits.maxDirectories, limits.maxEntries, limits.maxDepth]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('遍历上限必须为非负整数');
  }
  const reader = createProjectReader(projectRoot);
  const result: WalkResult = { files: [], diagnostics: [] };
  const diagnostic = (message: string) => result.diagnostics.push(sanitize(message));
  let gitignore = '';
  try { gitignore = (await reader.readText('.gitignore', options.signal)) ?? ''; }
  catch { options.signal?.throwIfAborted(); diagnostic('读取 .gitignore 失败，未应用项目忽略规则'); }
  const ignored = parseGitignore(gitignore);
  const queue = [''];
  let overflow = false;
  let entryCount = 0;
  for (let index = 0; index < queue.length && !overflow; index++) {
    options.signal?.throwIfAborted();
    if (index >= limits.maxDirectories) { diagnostic(`目录数量达到上限 ${limits.maxDirectories}，已停止遍历`); break; }
    const dir = queue[index]!;
    let entries;
    let entriesTruncated = false;
    try {
      entries = await reader.list(dir, options.signal, {
        maxEntries: limits.maxEntries - entryCount,
        onEntry: () => { entryCount++; },
        onDiagnostic: (message) => {
          if (message.includes('上限')) entriesTruncated = true;
          diagnostic(`${dir || '.'}: ${message}`);
        },
      });
    } catch { options.signal?.throwIfAborted(); diagnostic(`无法枚举目录 ${dir || '.'}`); continue; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      const ignoreName = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name;
      if (entry.link || DEFAULT_IGNORES.includes(ignoreName) || isCredential(entry.name) || ignored(relative, entry.type === 'directory')) continue;
      if (entry.type === 'directory') {
        if (relative.split('/').length > limits.maxDepth) diagnostic(`目录 ${relative} 超过深度上限 ${limits.maxDepth}，扫描不完整`);
        else queue.push(relative);
        continue;
      }
      if (result.files.length >= limits.maxFiles) { overflow = true; break; }
      result.files.push({ path: sanitize(relative), bytes: entry.size });
    }
    if (entriesTruncated) break;
  }
  if (overflow) diagnostic(`文件数量超过上限 ${limits.maxFiles}，已停止登记更多文件`);
  return result;
}
