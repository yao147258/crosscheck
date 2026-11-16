import YAML from 'yaml';
import { z } from 'zod';
import type { EditorHost } from './editor';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type EditOutcome<T> = { status: 'saved'; value: T; text: string } | { status: 'cancelled' };

const HEADER = '#! ';
const START = '#! 校验失败，修正后保存；不做修改直接关闭即放弃：\n';
const END = '#! 校验诊断结束\n';

export function withErrorHeader(error: string, body: string): string {
  const lines = error.split(/\r?\n/).map((line) => `${HEADER}${line}`);
  return `${START}${lines.join('\n')}\n${END}${body}`;
}

export function stripErrorHeader(text: string, expectedHeader?: string): string {
  if (expectedHeader !== undefined) {
    return text.startsWith(expectedHeader) ? text.slice(expectedHeader.length) : text;
  }
  if (!text.startsWith(START)) return text;
  const end = text.indexOf(END, START.length);
  return end < 0 ? text : text.slice(end + END.length);
}

export function parseYamlWith<T>(text: string, schema: z.ZodType<T>): ParseResult<T> {
  let data: unknown;
  try { data = YAML.parse(text) ?? null; }
  catch (error) {
    return { ok: false, error: `YAML 语法错误：${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = schema.safeParse(data);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: z.prettifyError(parsed.error) };
}

export async function editValidated<T>(
  editor: EditorHost,
  initial: string,
  parse: (text: string) => ParseResult<T>,
): Promise<EditOutcome<T>> {
  const normalize = (text: string) => text.replace(/\r\n/g, '\n');
  let previous = normalize(initial);
  let shown = previous;
  let diagnostic = '';
  for (;;) {
    const edited = normalize(await editor.edit(shown));
    const body = diagnostic ? stripErrorHeader(edited, diagnostic) : edited;
    if (body === previous) return { status: 'cancelled' };
    const result = parse(body);
    if (result.ok) return { status: 'saved', value: result.value, text: body };
    previous = body;
    diagnostic = withErrorHeader(result.error, '');
    shown = diagnostic + body;
  }
}
