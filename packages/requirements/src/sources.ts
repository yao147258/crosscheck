import { ClauseSchema, type Clause } from '@crosscheck/core';
import { z } from 'zod';

export interface RequirementDocument {
  file: string;
  text: string;
}

const MEBIBYTE = 1024 * 1024;
const normalizeNewlines = (text: string): string => text.replace(/\r\n/g, '\n');

export function prepareDocuments(module: string, documents: RequirementDocument[]): RequirementDocument[] {
  if (!/^[A-Za-z0-9_]+$/.test(module)) throw new Error('模块名不合法');
  if (!Array.isArray(documents) || documents.length === 0) throw new Error('需求文档不能为空');

  const files = new Set<string>();
  let total = 0;
  return documents.map((document) => {
    if (!document || typeof document.file !== 'string' ||
        document.file.includes('\\') || document.file.includes('\0') ||
        /^[A-Za-z]:/.test(document.file) ||
        document.file.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error('文档来源标识不合法');
    }
    if (files.has(document.file)) throw new Error('文档来源标识重复');
    files.add(document.file);
    if (typeof document.text !== 'string' || document.text.length === 0) throw new Error('文档内容不能为空');
    const size = Buffer.byteLength(document.text, 'utf8');
    total += size;
    if (size > MEBIBYTE || total > 2 * MEBIBYTE) throw new Error('文档大小超出限制');
    return { file: document.file, text: normalizeNewlines(document.text) };
  });
}

export function clausesForDocuments(module: string, documents: RequirementDocument[]): z.ZodType<Clause[]> {
  const texts = new Map(prepareDocuments(module, documents).map(({ file, text }) => [file, text]));
  return z.array(ClauseSchema).superRefine((clauses, ctx) => {
    const seen = new Set<string>();
    clauses.forEach((clause, index) => {
      if (seen.has(clause.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: '条款 ID 重复' });
      }
      seen.add(clause.id);
      if (!clause.id.startsWith(`${module}-AC-`)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: '条款 ID 不属于指定模块' });
      }
      const { file, line } = clause.source;
      const text = texts.get(file);
      if (text === undefined) {
        ctx.addIssue({ code: 'custom', path: [index, 'source', 'file'], message: '来源文件不在输入文档中' });
        return;
      }
      const lines = text.split('\n');
      if (!Number.isInteger(line) || line < 1 || line > lines.length) {
        ctx.addIssue({ code: 'custom', path: [index, 'source', 'line'], message: '来源行号越界' });
        return;
      }
      const excerpt = normalizeNewlines(clause.source.excerpt);
      const start = lines.slice(0, line - 1).reduce((offset, value) => offset + value.length + 1, 0);
      const position = excerpt.length ? text.indexOf(excerpt, start) : -1;
      if (position < start || position >= start + lines[line - 1]!.length) {
        ctx.addIssue({ code: 'custom', path: [index, 'source', 'excerpt'], message: '摘录必须从指定行内开始并与原文一致' });
      }
    });
  }).transform((clauses) => clauses.map((clause) => ({
    ...clause,
    source: { ...clause.source, excerpt: normalizeNewlines(clause.source.excerpt) },
  })));
}
