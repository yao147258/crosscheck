import { createProjectReader, isCredential } from './files';
import { sanitize, sanitizeMultiline } from './sanitize';

export const WALK_LIMITS = { maxFiles: 2000, maxDirectories: 2000, maxEntries: 10000, maxDepth: 32, excerptLinesPerFile: 100, excerptTotalLines: 400, excerptBytesPerLine: 2048, excerptBytesPerFile: 16384, excerptTotalBytes: 65536 } as const;
export const DEFAULT_IGNORES = ['node_modules', '.git', '.crosscheck', 'dist', 'build', 'out', 'coverage', '.next', 'target', 'venv', '.venv', '__pycache__', '.idea', '.vscode'];

export interface FileEntry { path: string; bytes: number; excerpt?: string[]; truncated?: boolean }
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

function priority(relative: string): number {
  const base = relative.split('/').at(-1)!.toLowerCase();
  if (base.startsWith('readme')) return 0;
  if (base.endsWith('.md')) return 1;
  if (/^(?:package\.json|tsconfig.*|vite\.config\..*|dockerfile.*|compose.*\.ya?ml|docker-compose.*\.ya?ml|pyproject\.toml|go\.mod|makefile|requirements.*\.txt)$/.test(base)) return 2;
  if (/^(?:src\/)?(?:index|main|app|routes|server)\.[cm]?[jt]sx?$/i.test(relative)) return 3;
  return 4;
}

// 按 Unicode 码点截断，避免切开 UTF-8 字节序列或代理对。
function truncateBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > limit) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

export async function walkProject(projectRoot: string, options: { maxFiles?: number; maxDirectories?: number; maxEntries?: number; maxDepth?: number; excerptLinesPerFile?: number; excerptTotalLines?: number; excerptBytesPerLine?: number; excerptBytesPerFile?: number; excerptTotalBytes?: number; signal?: AbortSignal } = {}): Promise<WalkResult> {
  const limits = { ...WALK_LIMITS, ...options };
  for (const value of [limits.maxFiles, limits.maxDirectories, limits.maxEntries, limits.maxDepth, limits.excerptLinesPerFile, limits.excerptTotalLines, limits.excerptBytesPerLine, limits.excerptBytesPerFile, limits.excerptTotalBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('遍历上限必须为非负整数');
  }
  const reader = createProjectReader(projectRoot);
  const result: WalkResult = { files: [], diagnostics: [] };
  const diagnostic = (message: string) => result.diagnostics.push(sanitize(message));
  let gitignore = '';
  try { gitignore = (await reader.readText('.gitignore', options.signal)) ?? ''; }
  catch { options.signal?.throwIfAborted(); diagnostic('读取 .gitignore 失败，未应用项目忽略规则'); }
  const ignored = parseGitignore(gitignore);
  const manifest: { raw: string; entry: FileEntry }[] = [];
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
      if (manifest.length >= limits.maxFiles) { overflow = true; break; }
      const file = { path: sanitize(relative), bytes: entry.size };
      manifest.push({ raw: relative, entry: file });
      result.files.push(file);
    }
    if (entriesTruncated) break;
  }
  if (overflow) diagnostic(`文件数量超过上限 ${limits.maxFiles}，已停止登记更多文件`);
  const candidates = manifest.filter((file) => priority(file.raw) < 4).sort((a, b) => priority(a.raw) - priority(b.raw) || a.raw.localeCompare(b.raw));
  let budget = limits.excerptTotalLines;
  let bytesRemaining = limits.excerptTotalBytes;
  for (const file of candidates) {
    options.signal?.throwIfAborted();
    let text: string | undefined;
    try { text = await reader.readText(file.raw, options.signal); }
    catch { options.signal?.throwIfAborted(); diagnostic(`无法读取文件 ${file.entry.path}`); continue; }
    if (text === undefined) { diagnostic(`文件读取时已不存在 ${file.entry.path}`); continue; }
    if (text.includes('\u0000')) continue;
    const lines = sanitizeMultiline(text).split(/\r?\n/);
    if (budget <= 0 || bytesRemaining <= 0) {
      if (lines.some((line) => line.length > 0)) {
        file.entry.truncated = true;
        diagnostic(`${file.entry.path} 摘录因总${budget <= 0 ? '行数' : '字节'}上限而省略`);
      }
      continue;
    }
    const count = Math.min(limits.excerptLinesPerFile, budget);
    file.entry.excerpt = [];
    let fileRemaining = limits.excerptBytesPerFile;
    let byteTruncated = false;
    for (const line of lines.slice(0, count)) {
      const clipped = truncateBytes(line, Math.min(limits.excerptBytesPerLine, fileRemaining, bytesRemaining));
      if (clipped !== line) byteTruncated = true;
      if (clipped) {
        file.entry.excerpt.push(clipped);
        const used = Buffer.byteLength(clipped, 'utf8');
        fileRemaining -= used;
        bytesRemaining -= used;
      }
    }
    budget -= file.entry.excerpt.length;
    if (lines.length > count || byteTruncated) {
      file.entry.truncated = true;
      if (lines.length > count) diagnostic(`${file.entry.path} 摘录截断到前 ${count} 行`);
      if (byteTruncated) diagnostic(`${file.entry.path} 摘录因字节上限截断`);
    }
  }
  return result;
}
