import { z } from 'zod';

/** 项目笔记以 UTF-8 字节计量，生成与审核共用相同的格式边界。 */
export const NotesTextSchema = z.string().min(1, '笔记不能为空')
  .refine((text) => Buffer.byteLength(text, 'utf8') <= 65536, '笔记不能超过 65536 字节')
  .refine((text) => text.split(/\r?\n/).some((line) => {
    const match = /^#{1,6}[ \t]+(.*)$/.exec(line);
    if (!match) return false;
    const content = match[1]!.trim().replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
    return content.length > 0;
  }), '笔记至少包含一个 Markdown 标题');

/** 严格解码笔记，避免不同非法字节被替换成相同文本。 */
export function decodeNotesUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('notes.md 不是有效的 UTF-8'); }
}

/**
 * 解析笔记中“需求文档”小节登记的路径。
 * 约定：标题文字为“需求文档”（任意层级），其下每行 `- \`路径\` 说明`，路径在反引号内、说明被忽略；
 * 遇到下一个标题结束。没有该小节或只写“未发现”时返回空数组。
 */
export function parseNotesRequirementDocs(text: string): string[] {
  const result: string[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    if (heading) {
      if (inSection) break;
      inSection = heading[1]!.trim() === '需求文档';
      continue;
    }
    if (!inSection) continue;
    const item = /^[ \t]*[-*][ \t]+`([^`]*)`/.exec(line);
    const entry = item?.[1]?.trim();
    if (entry) result.push(entry);
  }
  return [...new Set(result)];
}
