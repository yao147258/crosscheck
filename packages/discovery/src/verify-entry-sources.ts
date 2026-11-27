import { createProjectReader, normalizeSafeProjectPath, UnsafeProjectPathError } from './files';
import { cleanOpenApiText } from './openapi';
import { readCleanLines, type TextCleaner } from './project-tools';
import type { FileEntry } from './walk';

export interface EntrySource { file: string; line: number; excerpt: string }
export interface DroppedEntry { name: string; reason: string }

/** 重读登记文件并核验脱敏后的来源行，任一来源通过即保留条目。 */
export async function verifyEntrySources<T extends { sources: readonly EntrySource[] }>(options: {
  projectRoot: string;
  files: readonly Pick<FileEntry, 'path'>[];
  entries: Record<string, T>;
  clean?: TextCleaner;
  normalize?: TextCleaner;
  signal?: AbortSignal;
}): Promise<{ kept: Record<string, T>; dropped: DroppedEntry[]; unreadable: string[] }> {
  options.signal?.throwIfAborted();
  const reader = createProjectReader(options.projectRoot);
  const listed = new Set(options.files.map((file) => file.path));
  const cache = new Map<string, string[] | undefined>();
  const kept: [string, T][] = [];
  const dropped: DroppedEntry[] = [];
  const unreadable = new Set<string>();
  for (const [name, entry] of Object.entries(options.entries)) {
    options.signal?.throwIfAborted();
    let passed = false;
    let uncertain = false;
    for (const source of entry.sources) {
      options.signal?.throwIfAborted();
      const file = normalizeSafeProjectPath(source.file);
      if (!file || !listed.has(file) || !Number.isSafeInteger(source.line) || source.line < 1) continue;
      if (!cache.has(file)) {
        try { cache.set(file, await readCleanLines(reader, file, options.signal, options.clean)); }
        catch (error) {
          options.signal?.throwIfAborted();
          if (!(error instanceof UnsafeProjectPathError)) unreadable.add(file);
          cache.set(file, undefined);
        }
      }
      options.signal?.throwIfAborted();
      if (unreadable.has(file)) { uncertain = true; continue; }
      const text = cache.get(file)?.[source.line - 1]?.trim();
      const excerpt = source.excerpt.trim();
      // OpenAPI 摘录会先清理 URL，再由模型上下文脱敏重序列化。对已清洗的真实行复用同一处理，只接受完整行匹配。
      if (!passed && text && excerpt && (text.includes(excerpt) || options.normalize?.(text) === excerpt ||
          (text.startsWith('{') && options.normalize?.(cleanOpenApiText(text)) === excerpt))) passed = true;
    }
    if (passed) kept.push([name, entry]);
    else if (!uncertain) {
      const first = entry.sources[0];
      dropped.push({ name, reason: `来源核验失败${first ? `：${first.file}:${first.line}` : ''}` });
    }
  }
  return { kept: Object.fromEntries(kept), dropped, unreadable: [...unreadable] };
}
