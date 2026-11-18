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
