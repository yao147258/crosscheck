import { defineTool, type AgentTool } from '@crosscheck/agent';
import type { BudgetTracker } from '@crosscheck/core';
import { reportProgress } from '@crosscheck/models';
import { z } from 'zod';
import { createProjectReader } from './files';
import { sanitize, sanitizeMultiline } from './sanitize';
import type { ProjectReader } from './types';
import type { FileEntry } from './walk';

export type TextCleaner = (text: string) => string;

export const PROJECT_TOOL_LIMITS = { listEntries: 200, readLines: 200, readBytes: 16384, lineChars: 500, grepMatches: 100 } as const;
export const BUDGET_NOTICE = '[额度即将用完，请停止读取，立即用 finish 提交]';

const identity: TextCleaner = (text) => text;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 逐行脱敏读取：sanitizeMultiline 不增删行，行号与原文件一致。文件不存在返回 undefined。 */
export async function readCleanLines(reader: ProjectReader, file: string, signal?: AbortSignal, clean: TextCleaner = identity): Promise<string[] | undefined> {
  const text = await reader.readText(file, signal);
  if (text === undefined) return undefined;
  if (text.includes('\u0000')) throw new Error('二进制文件不可读取');
  return sanitizeMultiline(text).split('\n').map((line) => clean(line.replace(/\r$/, '')));
}

/** 剩余步数 ≤ 5，或剩余 token、时长低于 15% 时视为即将耗尽。 */
export function budgetLow(budget: BudgetTracker): boolean {
  const left = budget.remaining();
  const used = budget.snapshot();
  const ratio = (rest: number, spent: number) => rest + spent > 0 ? rest / (rest + spent) : 0;
  return left.steps <= 5 || ratio(left.tokens, used.tokens) < 0.15 || ratio(left.ms, used.elapsedMs) < 0.15;
}

/** 统一模型给出的相对路径写法：反斜杠、开头的 ./、结尾的 /，单独的 . 表示根目录。 */
function normalize(path: string): string {
  const value = path.trim().replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return value === '.' ? '' : value;
}

function clip(text: string): string {
  return text.length > PROJECT_TOOL_LIMITS.lineChars ? `${text.slice(0, PROJECT_TOOL_LIMITS.lineChars)}…[行过长已截断]` : text;
}

/** 只读项目工具；访问范围限定为 walk 登记的文件清单（已排除忽略目录、凭证与符号链接）。 */
export function createProjectTools(options: { projectRoot: string; files: readonly FileEntry[]; budget: BudgetTracker; clean?: TextCleaner }): AgentTool[] {
  const reader = createProjectReader(options.projectRoot);
  const clean = options.clean ?? identity;
  const files = new Map(options.files.map((file) => [file.path, file]));
  const sorted = [...files.keys()].sort();
  const show = (text: string) => clean(sanitize(text));
  const withNotice = <T extends object>(value: T) => budgetLow(options.budget) ? { ...value, notice: BUDGET_NOTICE } : value;
  const { listEntries, readLines, readBytes, grepMatches } = PROJECT_TOOL_LIMITS;

  const listDir = defineTool({
    name: 'list_dir', category: 'project',
    description: '列出项目目录的直接子项（仅含已登记文件，已排除忽略目录与凭证文件）；path 为空或 . 表示项目根目录',
    input: z.object({ path: z.string().default('') }),
    async execute(input) {
      const dir = normalize(input.path);
      reportProgress(`列出 ${show(dir || '.')}`);
      const prefix = dir ? `${dir}/` : '';
      const children = new Map<string, { name: string; type: 'dir'; files: number } | { name: string; type: 'file'; bytes: number }>();
      for (const path of sorted) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) { children.set(rest, { name: rest, type: 'file', bytes: files.get(path)!.bytes }); continue; }
        const name = rest.slice(0, slash);
        const current = children.get(name);
        if (current?.type === 'dir') current.files++;
        else children.set(name, { name, type: 'dir', files: 1 });
      }
      if (!children.size) throw new Error('目录不存在、为空或已被忽略');
      const entries = [...children.values()].map((entry) => ({ ...entry, name: show(entry.name) }));
      return withNotice({
        path: show(dir || '.'), entries: entries.slice(0, listEntries),
        ...(entries.length > listEntries ? { truncated: `仅显示前 ${listEntries} 项，共 ${entries.length} 项` } : {}),
      });
    },
  });

  const readFile = defineTool({
    name: 'read_file', category: 'project',
    description: `读取项目文件，返回带行号的文本；单次最多 ${readLines} 行、${readBytes} 字节，可用 startLine 分段继续读取`,
    input: z.object({ path: z.string().min(1), startLine: z.number().int().positive().default(1), lineCount: z.number().int().positive().max(readLines).default(readLines) }),
    async execute(input, ctx) {
      const path = normalize(input.path);
      if (!files.has(path)) throw new Error('文件不在项目文件清单中（可能已被忽略、是凭证文件或不存在）');
      reportProgress(`读取 ${show(path)}`);
      const lines = await readCleanLines(reader, path, ctx.signal, clean);
      if (!lines) throw new Error('文件已不存在');
      const start = Math.min(input.startLine, Math.max(1, lines.length));
      const out: string[] = [];
      let bytes = 0;
      for (let line = start; line <= lines.length && out.length < input.lineCount; line++) {
        const entry = `${line}: ${clip(lines[line - 1]!)}`;
        const size = Buffer.byteLength(entry, 'utf8') + 1;
        if (out.length && bytes + size > readBytes) break;
        out.push(entry);
        bytes += size;
      }
      const end = start + out.length - 1;
      return withNotice({
        path: show(path), totalLines: lines.length, startLine: start, endLine: end, content: out.join('\n'),
        ...(end < lines.length ? { more: `还有后续内容，可用 startLine=${end + 1} 继续读取` } : {}),
      });
    },
  });

  const grep = defineTool({
    name: 'grep', category: 'project',
    description: `在已登记文件中按普通文本（不区分大小写，非正则）搜索，返回 文件:行号: 原文，最多 ${grepMatches} 条；可用 path 限定目录、glob 限定文件名（仅支持 *）`,
    input: z.object({ pattern: z.string().min(1).max(200), path: z.string().default(''), glob: z.string().min(1).max(100).optional() }),
    async execute(input, ctx) {
      const dir = normalize(input.path);
      const needle = input.pattern.toLowerCase();
      const glob = input.glob ? new RegExp(`^${input.glob.split('*').map(escapeRegExp).join('[^/]*')}$`, 'i') : undefined;
      reportProgress(`搜索 "${show(input.pattern)}" (${show(dir || '.')})`);
      const matches: string[] = [];
      let truncated = false;
      for (const path of sorted) {
        if (dir && path !== dir && !path.startsWith(`${dir}/`)) continue;
        if (glob && !glob.test(path.split('/').at(-1)!) && !glob.test(path)) continue;
        ctx.signal.throwIfAborted();
        let lines: string[] | undefined;
        try { lines = await readCleanLines(reader, path, ctx.signal, clean); }
        catch { ctx.signal.throwIfAborted(); continue; }
        for (let i = 0; lines && i < lines.length; i++) {
          if (!lines[i]!.toLowerCase().includes(needle)) continue;
          if (matches.length >= grepMatches) { truncated = true; break; }
          matches.push(`${show(path)}:${i + 1}: ${clip(lines[i]!.trim())}`);
        }
        if (truncated) break;
      }
      return withNotice({ matches, ...(truncated ? { truncated: `仅显示前 ${grepMatches} 条，请用 path 或 glob 缩小范围` } : {}) });
    },
  });

  return [listDir, readFile, grep];
}
