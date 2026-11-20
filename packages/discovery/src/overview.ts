import { createProjectReader } from './files';
import { readCleanLines, type TextCleaner } from './project-tools';
import { sanitize } from './sanitize';
import type { FileEntry } from './walk';

export const OVERVIEW_LIMITS = { fullListFiles: 300, maxChars: 8000, maxDepth: 3, keyFiles: 60, readmeLines: 60 } as const;

const identity: TextCleaner = (text) => text;
const CONFIG = /^(?:package\.json|tsconfig.*\.json|vite\.config\..*|webpack\.config\..*|next\.config\..*|nuxt\.config\..*|dockerfile.*|compose.*\.ya?ml|docker-compose.*\.ya?ml|pyproject\.toml|requirements.*\.txt|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|cargo\.toml|makefile|application.*\.(?:ya?ml|properties)|\.env\.example)$/;
const ENTRY = /(?:^|\/)(?:index|main|app|server|routes?|router)\.[cm]?[jt]sx?$/;

/** 文件重要程度：0 README，1 构建/部署配置，2 源码入口与路由（根目录或 src 下），3 其他 Markdown，4 其他。 */
export function keyFileRank(path: string): number {
  const parts = path.split('/');
  const base = parts.at(-1)!.toLowerCase();
  if (base.startsWith('readme')) return 0;
  if (CONFIG.test(base)) return 1;
  if (ENTRY.test(path) && (parts.length === 1 || parts.at(-2) === 'src')) return 2;
  if (base.endsWith('.md')) return 3;
  return 4;
}

// 用 \0 替换 / 后比较，保证 a/b 紧跟在 a 之后，不被 a-c 之类插开。
const treeOrder = (a: string, b: string) => {
  const x = a.replaceAll('/', '\u0000');
  const y = b.replaceAll('/', '\u0000');
  return x < y ? -1 : x > y ? 1 : 0;
};

function tree(paths: readonly string[], depth: number): string[] {
  const counts = new Map<string, number>();
  let rootFiles = 0;
  for (const path of paths) {
    const parts = path.split('/').slice(0, -1);
    if (!parts.length) rootFiles++;
    for (let i = 1; i <= Math.min(depth, parts.length); i++) {
      const dir = parts.slice(0, i).join('/');
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  const lines = [...counts.keys()].sort(treeOrder).map((dir) => {
    const parts = dir.split('/');
    return `${'  '.repeat(parts.length - 1)}${parts.at(-1)}/ (${counts.get(dir)})`;
  });
  return rootFiles ? [`./ 根目录文件 (${rootFiles})`, ...lines] : lines;
}

function fit(text: string): string {
  return text.length <= OVERVIEW_LIMITS.maxChars ? text : `${text.slice(0, OVERVIEW_LIMITS.maxChars - 20)}\n…（概览已截断）`;
}

/** 目录概览：小项目给完整清单；大项目按目录聚合并附关键文件，过长时逐级减少展开层数。 */
export function buildOverview(files: readonly FileEntry[], clean: TextCleaner = identity): string {
  const show = (text: string) => clean(sanitize(text));
  const paths = files.map((file) => file.path).sort();
  if (paths.length <= OVERVIEW_LIMITS.fullListFiles) return fit([`共 ${paths.length} 个文件：`, ...paths.map(show)].join('\n'));
  const key = paths.filter((path) => keyFileRank(path) < 4).sort((a, b) => keyFileRank(a) - keyFileRank(b) || treeOrder(a, b));
  let text = '';
  for (let depth = OVERVIEW_LIMITS.maxDepth; depth >= 1; depth--) {
    text = [
      `共 ${paths.length} 个文件，按目录聚合（最多 ${depth} 层，括号内为文件数）：`,
      ...tree(paths, depth).map(show),
      '',
      `关键文件（共 ${key.length} 个，最多列出 ${OVERVIEW_LIMITS.keyFiles} 个）：`,
      ...key.slice(0, OVERVIEW_LIMITS.keyFiles).map(show),
    ].join('\n');
    if (text.length <= OVERVIEW_LIMITS.maxChars) return text;
  }
  return fit(text);
}

/** 根目录 README 前若干行；读取失败（含中断）时返回 undefined，由调用方的代理循环处理中断。 */
export async function readReadmeHead(projectRoot: string, files: readonly FileEntry[], signal?: AbortSignal, clean: TextCleaner = identity): Promise<string[] | undefined> {
  const readme = files.find((file) => !file.path.includes('/') && /^readme/i.test(file.path));
  if (!readme) return undefined;
  try {
    const lines = await readCleanLines(createProjectReader(projectRoot), readme.path, signal, clean);
    return lines?.slice(0, OVERVIEW_LIMITS.readmeLines);
  } catch { return undefined; }
}
