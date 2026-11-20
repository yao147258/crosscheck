import path from 'node:path';
import { isSafeProjectPath } from './files';
import type { ProjectLister } from './types';

export const REQUIREMENT_DOC_LIMITS = { maxDepth: 8, maxFiles: 100 } as const;
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.crosscheck']);
const DIR_ENTRY_LIMIT = 5000;

/** 返回 `dir` 之下所有候选文件的项目相对路径（`/` 分隔），来源可以是磁盘或 Git。 */
export type DocDirLister = (dir: string, signal?: AbortSignal) => Promise<string[]>;

/** 统一为 `/` 分隔并去掉 `.` 与空段；原始写法以分隔符结尾视为目录。 */
export function parseDocEntry(entry: string): { path: string; directory: boolean } {
  const slashed = entry.replaceAll('\\', '/');
  return { path: slashed.split('/').filter((part) => part && part !== '.').join('/'), directory: slashed.endsWith('/') };
}

/** 绝对路径（含 Windows 盘符与 UNC）：规范化会吞掉前导分隔符，必须在规范化之前识别。 */
function isAbsoluteEntry(entry: string): boolean {
  return path.posix.isAbsolute(entry.replaceAll('\\', '/')) || path.win32.isAbsolute(entry) || /^[a-z]:/i.test(entry);
}

/** 磁盘来源：递归列目录，跳过符号链接、不安全路径与忽略目录；深度到上限后不再下探。 */
export function createDiskDocLister(reader: ProjectLister, onDiagnostic?: (message: string) => void): DocDirLister {
  return async (dir, signal) => {
    const files: string[] = [];
    const walk = async (current: string, depth: number): Promise<void> => {
      signal?.throwIfAborted();
      const entries = await reader.list(current, signal, { maxEntries: DIR_ENTRY_LIMIT, onDiagnostic });
      for (const entry of entries) {
        const child = `${current}/${entry.name}`;
        if (entry.link) { onDiagnostic?.(`跳过符号链接：${child}`); continue; }
        if (!isSafeProjectPath(child)) continue;
        if (entry.type === 'directory') {
          if (SKIPPED_DIRS.has(entry.name) || depth >= REQUIREMENT_DOC_LIMITS.maxDepth) continue;
          await walk(child, depth + 1);
        } else files.push(child);
      }
    };
    await walk(dir, 0);
    return files;
  };
}

/**
 * 把 requirementsDocs 条目展开成排序、去重后的文件列表。
 * 目录（以 `/` 结尾）递归收集 `.md`；显式文件原样保留，由后续读取器校验路径安全。
 */
export async function expandRequirementDocs(entries: string[], listDir: DocDirLister, signal?: AbortSignal, options: { allowEmpty?: boolean } = {}): Promise<string[]> {
  const result = new Set<string>();
  for (const entry of entries) {
    signal?.throwIfAborted();
    const { path: normalized, directory } = parseDocEntry(entry);
    if (isAbsoluteEntry(entry)) {
      // 显式绝对文件原样保留，交给读取器/impact 拒绝；绝对目录直接报不安全。
      if (directory) throw new Error(`需求文档目录路径不安全：${entry}`);
      result.add(entry);
      continue;
    }
    if (!directory) {
      if (!normalized) throw new Error('需求文档路径无效');
      result.add(normalized);
      continue;
    }
    if (!normalized) throw new Error('需求文档目录不能是项目根目录');
    if (!isSafeProjectPath(normalized)) throw new Error(`需求文档目录路径不安全：${entry}`);
    const prefix = `${normalized}/`;
    const found = (await listDir(normalized, signal)).map((file) => file.replaceAll('\\', '/')).filter((file) => {
      if (!file.startsWith(prefix)) return false;
      const parts = file.slice(prefix.length).split('/');
      return parts.length <= REQUIREMENT_DOC_LIMITS.maxDepth + 1
        && /\.md$/i.test(parts[parts.length - 1]!)
        && !parts.slice(0, -1).some((part) => SKIPPED_DIRS.has(part))
        && isSafeProjectPath(file);
    });
    if (found.length === 0 && !options.allowEmpty) throw new Error(`需求文档目录不存在或没有 .md 文件：${normalized}/`);
    for (const file of found) result.add(file);
  }
  const files = [...result].sort();
  if (files.length > REQUIREMENT_DOC_LIMITS.maxFiles) throw new Error(`需求文档超过 ${REQUIREMENT_DOC_LIMITS.maxFiles} 个文件上限，请缩小目录范围`);
  return files;
}
