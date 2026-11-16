import YAML from 'yaml';
import { z } from 'zod';
import type { EditorHost } from './editor';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type EditOutcome<T> = { status: 'saved'; value: T; text: string } | { status: 'cancelled' };

const HEADER = '#! ';

export function withErrorHeader(error: string, body: string): string {
  const lines = ['校验失败，修正后保存；不做修改直接关闭即放弃：', ...error.split(/\r?\n/)]
    .map((line) => `${HEADER}${line}`);
  return `${lines.join('\n')}\n${body}`;
}

export function stripErrorHeader(text: string): string {
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length && lines[index]!.startsWith('#!')) index++;
  return lines.slice(index).join('\n');
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
  for (;;) {
    const body = stripErrorHeader(normalize(await editor.edit(shown)));
    if (body === previous) return { status: 'cancelled' };
    const result = parse(body);
    if (result.ok) return { status: 'saved', value: result.value, text: body };
    previous = body;
    shown = withErrorHeader(result.error, body);
  }
}
