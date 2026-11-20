import { z } from 'zod';
import { createProjectReader, isSafeProjectPath } from './files';
import { readCleanLines, type TextCleaner } from './project-tools';
import { sanitize } from './sanitize';
import type { DiscoveryFact, DiscoverySource } from './types';
import type { FileEntry } from './walk';

export const FINDING_LIMIT = 500;
const EXCERPT_CHARS = 200;

const Source = z.object({ file: z.string().min(1), line: z.number().int().positive(), excerpt: z.string().min(1) });
export const FindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('api'), method: z.string().min(1), path: z.string().min(1), summary: z.string().default(''),
    parameters: z.array(z.object({ name: z.string(), in: z.string(), required: z.boolean(), type: z.string().optional() })).default([]),
    source: Source,
  }),
  z.object({ kind: z.literal('command'), name: z.string().min(1), command: z.string().min(1), source: Source }),
  z.object({ kind: z.literal('port'), port: z.number().int().min(1).max(65535), service: z.string().optional(), source: Source }),
  z.object({ kind: z.literal('environment-variable'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), source: Source }),
  z.object({ kind: z.literal('page'), path: z.string().min(1), summary: z.string().default(''), source: Source }),
]);
export type Finding = z.infer<typeof FindingSchema>;

/** 去重键：同键视为同一事实。 */
export function factKey(fact: DiscoveryFact | Finding): string {
  switch (fact.kind) {
    case 'api': return `api ${fact.method.toUpperCase()} ${fact.path}`;
    case 'command': return `command ${fact.command.trim()}`;
    case 'port': return `port ${fact.port}`;
    case 'environment-variable': return `env ${fact.name}`;
    case 'page': return `page ${fact.path}`;
    case 'project': return `project ${fact.ecosystem} ${fact.name}`;
  }
}

/** 命令、端口、环境变量的值必须出现在来源行；接口与页面的完整路径常由多处拼接，只核验来源行。 */
function valuePresent(finding: Finding, text: string): boolean {
  switch (finding.kind) {
    case 'command': return text.includes(sanitize(finding.command.trim()));
    case 'port': return new RegExp(`(?<!\\d)${finding.port}(?!\\d)`).test(text);
    case 'environment-variable': return new RegExp(`(?<![A-Za-z0-9_])${finding.name}(?![A-Za-z0-9_])`).test(text);
    default: return true;
  }
}

function toFact(finding: Finding, source: DiscoverySource): DiscoveryFact {
  const plugin = 'agent';
  switch (finding.kind) {
    case 'api': return { kind: 'api', plugin, method: finding.method.toUpperCase(), path: sanitize(finding.path), summary: sanitize(finding.summary), parameters: finding.parameters, servers: [], source };
    case 'command': return { kind: 'command', plugin, name: sanitize(finding.name), command: sanitize(finding.command.trim()), source };
    case 'port': return { kind: 'port', plugin, port: finding.port, ...(finding.service ? { service: sanitize(finding.service) } : {}), source };
    case 'environment-variable': return { kind: 'environment-variable', plugin, name: finding.name, source };
    case 'page': return { kind: 'page', plugin, path: sanitize(finding.path), summary: sanitize(finding.summary), source };
  }
}

/** 宿主重读文件逐条核验模型发现；返回新增的核验通过事实（静态事实同键优先）与丢弃诊断。 */
export async function verifyFindings(options: {
  projectRoot: string;
  files: readonly FileEntry[];
  findings: readonly Finding[];
  facts: readonly DiscoveryFact[];
  clean?: TextCleaner;
  signal?: AbortSignal;
}): Promise<{ facts: DiscoveryFact[]; diagnostics: string[] }> {
  const reader = createProjectReader(options.projectRoot);
  const clean = options.clean ?? ((text: string) => text);
  const listed = new Set(options.files.map((file) => file.path));
  const seen = new Set(options.facts.map(factKey));
  const cache = new Map<string, string[] | undefined>();
  const facts: DiscoveryFact[] = [];
  const diagnostics: string[] = [];
  for (const finding of options.findings.slice(0, FINDING_LIMIT)) {
    options.signal?.throwIfAborted();
    const file = finding.source.file.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
    let lines: string[] | undefined;
    if (isSafeProjectPath(file) && listed.has(file)) {
      if (!cache.has(file)) {
        try { cache.set(file, await readCleanLines(reader, file, options.signal, clean)); }
        catch { options.signal?.throwIfAborted(); cache.set(file, undefined); }
      }
      lines = cache.get(file);
    }
    const text = lines?.[finding.source.line - 1]?.trim();
    const excerpt = finding.source.excerpt.trim();
    if (!text || !excerpt || !text.includes(excerpt) || !valuePresent(finding, text)) {
      diagnostics.push(clean(sanitize(`发现来源核验失败已丢弃：${finding.kind} ${finding.source.file}:${finding.source.line}`)));
      continue;
    }
    const key = factKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    const normalized = finding.kind === 'environment-variable' ? `${finding.name}=[已隐藏]` : text.slice(0, EXCERPT_CHARS);
    facts.push(toFact(finding, { file, line: finding.source.line, excerpt: normalized }));
  }
  return { facts, diagnostics };
}
