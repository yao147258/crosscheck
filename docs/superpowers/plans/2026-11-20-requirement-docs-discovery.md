# 需求文档目录支持与笔记驱动发现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `requirementsDocs` 支持目录（递归展开 `.md`），并让 `init` 在笔记里给出“需求文档”小节，经 `review notes` 确认后由 `reqs`、`impact` 读取。

**Architecture:** core 提供纯函数 `parseNotesRequirementDocs` 解析笔记小节；discovery 提供 `expandRequirementDocs`（规则集中在一处，通过注入的“列目录函数”同时服务磁盘与 Git 两种来源）；cli 的 `reqs` 与 `impact` 调用它们。`config.yaml` 的 `requirementsDocs` 非空时优先，否则使用笔记小节。程序不改写任何用户文件。

**Tech Stack:** TypeScript、pnpm monorepo、vitest（测试用 `pnpm vitest run <文件> --maxWorkers=1 --testTimeout=15000`）、Node >= 22.12。

**Spec:** `docs/superpowers/specs/2026-11-20-requirement-docs-discovery-design.md`

## Global Constraints

- 所有对话、文档、代码注释使用中文。
- 目录写法：以 `/` 结尾（`docs/prd/`）；不支持 glob。
- 只收 `.md`（扩展名不区分大小写），仅对**目录展开**生效；显式写出的文件路径保持现有行为（不限扩展名，不安全路径由读取器报错）。
- 递归最大深度 8（入口目录之下最多 8 层子目录）；展开后文件总数上限 100，超限报错，不静默截断；总大小 2 MiB 的限制保留在 `readRequirementDocuments`。
- 跳过符号链接（给诊断）、凭证与不安全路径（`isSafeProjectPath`）、`node_modules`、`.git`、`.crosscheck`。
- 路径统一为 `/` 分隔，去重，字典序排序（默认 `.sort()`）。
- 笔记小节约定：标题为“需求文档”，每行 `` - `路径` 说明文字 ``，路径在反引号内；`NotesTextSchema` 不改。
- `reqs` 取清单优先级：`config.yaml` 的 `requirementsDocs` 非空 > 已确认笔记的小节。用笔记小节时笔记必须已确认。两处都为空时提示必须包含原有文字 `requirementsDocs 为空`（现有测试断言它）。
- 缺失的显式文件、`..` 路径仍是宿主错误（退出码 3），不得被新逻辑吞掉。
- 提交信息结尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 工作目录：`E:\crosscheck\.claude\worktrees\requirement-docs-discovery`，分支 `worktree-requirement-docs-discovery`。

---

### Task 1: 笔记小节解析函数（core）

**Files:**
- Modify: `packages/core/src/schema/notes.ts`（末尾追加）
- Test: `packages/core/test/notes-requirement-docs.test.ts`（新建）

**Interfaces:**
- Consumes: 无。
- Produces: `parseNotesRequirementDocs(text: string): string[]`，从 `@crosscheck/core` 导出（`core/src/index.ts` 已 `export * from './schema/notes'`，无需改动）。

- [ ] **Step 1: 写失败的测试**

新建 `packages/core/test/notes-requirement-docs.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseNotesRequirementDocs } from '../src/index';

describe('笔记“需求文档”小节解析', () => {
  it('没有该小节时返回空数组', () => {
    expect(parseNotesRequirementDocs('# 笔记\n\n## 启动方式\n\n- `pnpm dev`\n')).toEqual([]);
  });
  it('提取反引号内的路径并忽略说明文字', () => {
    const text = '# 笔记\n\n## 需求文档\n\n- `docs/prd/` 产品需求\n- `README.md` 项目说明\n\n## 其他\n\n- `不应读取.md`\n';
    expect(parseNotesRequirementDocs(text)).toEqual(['docs/prd/', 'README.md']);
  });
  it('“未发现”与反引号之外的行不产生条目', () => {
    expect(parseNotesRequirementDocs('# 笔记\n\n## 需求文档\n\n未发现\n- docs/a.md 没有反引号\n')).toEqual([]);
  });
  it('遇到下一个标题结束，支持 * 列表、CRLF、去重和尾部井号标题', () => {
    const text = '# 笔记\r\n\r\n## 需求文档 ##\r\n\r\n* `a.md`\r\n- `a.md`\r\n- `b/`\r\n\r\n## 后续\r\n- `c.md`\r\n';
    expect(parseNotesRequirementDocs(text)).toEqual(['a.md', 'b/']);
  });
  it('其他标题层级的“需求文档”也识别，空反引号被忽略', () => {
    expect(parseNotesRequirementDocs('# 笔记\n\n### 需求文档\n- `x.md`\n- `  `\n')).toEqual(['x.md']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core/test/notes-requirement-docs.test.ts --maxWorkers=1 --testTimeout=15000`
Expected: FAIL，提示 `parseNotesRequirementDocs` 不是函数或未导出。

- [ ] **Step 3: 实现**

在 `packages/core/src/schema/notes.ts` 末尾追加：

```ts

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
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/core/test/notes-requirement-docs.test.ts --maxWorkers=1 --testTimeout=15000`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/schema/notes.ts packages/core/test/notes-requirement-docs.test.ts
git commit -m "feat(core): 解析笔记中的需求文档小节

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 需求文档目录展开（discovery）

**Files:**
- Create: `packages/discovery/src/requirement-docs.ts`
- Modify: `packages/discovery/src/index.ts`（追加导出）
- Test: `packages/discovery/test/requirement-docs.test.ts`（新建）

**Interfaces:**
- Consumes: `isSafeProjectPath` from `./files`；`ProjectLister` from `./types`。
- Produces（均从 `@crosscheck/discovery` 导出）：
  - `REQUIREMENT_DOC_LIMITS: { readonly maxDepth: 8; readonly maxFiles: 100 }`
  - `type DocDirLister = (dir: string, signal?: AbortSignal) => Promise<string[]>`：返回 `dir` 之下所有候选文件的项目相对路径（`/` 分隔，可含非 `.md`），由调用方提供来源（磁盘或 Git）。
  - `parseDocEntry(entry: string): { path: string; directory: boolean }`
  - `createDiskDocLister(reader: ProjectLister, onDiagnostic?: (message: string) => void): DocDirLister`
  - `expandRequirementDocs(entries: string[], listDir: DocDirLister, signal?: AbortSignal, options?: { allowEmpty?: boolean }): Promise<string[]>`：`allowEmpty` 为 true 时，目录展开后没有 `.md` 不报错（`impact` 用，因为某一侧可能还没有该目录）。

- [ ] **Step 1: 写失败的测试**

新建 `packages/discovery/test/requirement-docs.test.ts`：

```ts
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiskDocLister, createProjectReader, expandRequirementDocs, parseDocEntry } from '../src/index';

let root: string;
let outside: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reqdocs-root-'));
  outside = await mkdtemp(join(tmpdir(), 'reqdocs-outside-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
async function put(file: string, text = '内容') {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}
const expand = (entries: string[], options?: { allowEmpty?: boolean }, diagnostics: string[] = [], signal?: AbortSignal) =>
  expandRequirementDocs(entries, createDiskDocLister(createProjectReader(root), (m) => diagnostics.push(m)), signal, options);

describe('parseDocEntry', () => {
  it('统一分隔符并识别目录写法', () => {
    expect(parseDocEntry('docs\\prd\\')).toEqual({ path: 'docs/prd', directory: true });
    expect(parseDocEntry('./docs/a.md')).toEqual({ path: 'docs/a.md', directory: false });
  });
});

describe('expandRequirementDocs', () => {
  it('多层嵌套只收 .md（不区分大小写），结果排序', async () => {
    await put('docs/prd/b.md'); await put('docs/prd/a.md'); await put('docs/prd/sub/deep/c.MD');
    await put('docs/prd/img.png'); await put('docs/prd/notes.txt');
    expect(await expand(['docs/prd/'])).toEqual(['docs/prd/a.md', 'docs/prd/b.md', 'docs/prd/sub/deep/c.MD']);
  });
  it('反斜杠目录写法等价', async () => {
    await put('docs/prd/a.md');
    expect(await expand(['docs\\prd\\'])).toEqual(['docs/prd/a.md']);
  });
  it('跳过忽略目录、凭证与不安全名称', async () => {
    await put('docs/ok.md'); await put('docs/node_modules/x.md'); await put('docs/.git/y.md');
    await put('docs/.crosscheck/z.md'); await put('docs/.env.d/a.md'); await put('docs/secrets.md');
    expect(await expand(['docs/'])).toEqual(['docs/ok.md']);
  });
  it('跳过符号链接并给出诊断', async () => {
    await put('docs/ok.md');
    await writeFile(join(outside, 'leak.md'), '外部');
    await mkdir(join(root, 'docs'), { recursive: true });
    await symlink(outside, join(root, 'docs', 'link'), 'junction');
    const diagnostics: string[] = [];
    expect(await expand(['docs/'], undefined, diagnostics)).toEqual(['docs/ok.md']);
    expect(diagnostics.join('\n')).toContain('跳过符号链接');
  });
  it('深度 8 层子目录内的文件被收录，第 9 层被忽略', async () => {
    await put(`docs/${'d/'.repeat(8)}in.md`); await put(`docs/${'d/'.repeat(9)}out.md`);
    expect(await expand(['docs/'])).toEqual([`docs/${'d/'.repeat(8)}in.md`]);
  });
  it('文件总数超过 100 个报错而不是截断', async () => {
    await Promise.all(Array.from({ length: 101 }, (_, i) => put(`docs/f${i}.md`)));
    await expect(expand(['docs/'])).rejects.toThrow('100');
  });
  it('目录不存在或没有 .md 报错；allowEmpty 时返回空', async () => {
    await put('empty/readme.txt');
    await expect(expand(['missing/'])).rejects.toThrow('没有 .md');
    await expect(expand(['empty/'])).rejects.toThrow('没有 .md');
    expect(await expand(['missing/', 'empty/'], { allowEmpty: true })).toEqual([]);
  });
  it('项目根目录不允许作为需求文档目录', async () => {
    await expect(expand(['./'])).rejects.toThrow('根目录');
  });
  it('不安全的目录写法报错', async () => {
    await expect(expand(['../outside/'])).rejects.toThrow('不安全');
  });
  it('目录与显式文件混合时去重，显式文件不限扩展名', async () => {
    await put('docs/a.md'); await put('docs/b.txt');
    expect(await expand(['docs/', 'docs/a.md', 'docs\\a.md', 'docs/b.txt'])).toEqual(['docs/a.md', 'docs/b.txt']);
  });
  it('取消信号中止展开', async () => {
    await put('docs/a.md');
    const controller = new AbortController(); controller.abort();
    await expect(expand(['docs/'], undefined, [], controller.signal)).rejects.toThrow();
  });
  it('注入的列目录函数（如 Git）同样套用过滤、前缀与排序规则', async () => {
    const lister = async () => ['docs/b.md', 'docs/a.md', 'docs/x.png', 'other/y.md', 'docs/node_modules/z.md'];
    expect(await expandRequirementDocs(['docs/'], lister)).toEqual(['docs/a.md', 'docs/b.md']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/discovery/test/requirement-docs.test.ts --maxWorkers=1 --testTimeout=15000`
Expected: FAIL，导入的符号不存在。

- [ ] **Step 3: 实现**

新建 `packages/discovery/src/requirement-docs.ts`：

```ts
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
```

在 `packages/discovery/src/index.ts` 的 `createProjectReader` 那行之后追加：

```ts
export { REQUIREMENT_DOC_LIMITS, createDiskDocLister, expandRequirementDocs, parseDocEntry } from './requirement-docs';
export type { DocDirLister } from './requirement-docs';
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/discovery/test/requirement-docs.test.ts --maxWorkers=1 --testTimeout=15000`
Expected: PASS（所有用例）。

- [ ] **Step 5: 类型检查并提交**

Run: `pnpm typecheck`
Expected: 无输出（通过）。

```bash
git add packages/discovery/src/requirement-docs.ts packages/discovery/src/index.ts packages/discovery/test/requirement-docs.test.ts
git commit -m "feat(discovery): 新增需求文档目录展开

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: reqs 接入目录展开与笔记小节

**Files:**
- Modify: `packages/cli/src/documents.ts`（新增 `resolveRequirementEntries`）
- Modify: `packages/cli/src/reqs.ts:14-15`
- Test: `packages/cli/test/reqs-plan.test.ts`（文件末尾追加；复用其中的 `project`、`deps`、`finish`、`c1`、`c2`、`cliMain`）

**Interfaces:**
- Consumes: Task 1 的 `parseNotesRequirementDocs`；Task 2 的 `expandRequirementDocs`、`createDiskDocLister`；`createProjectReader`（已从 `@crosscheck/discovery` 导出）。
- Produces: `resolveRequirementEntries(artifacts: ArtifactStore, configured: string[]): Promise<RequirementEntries>`，其中 `type RequirementEntries = { ok: true; entries: string[]; from: 'config' | 'notes' } | { ok: false; message: string }`。

- [ ] **Step 1: 写失败的测试**

在 `packages/cli/test/reqs-plan.test.ts` 末尾追加（`Approvals` 已在该文件顶部导入）：

```ts
const docTwo = '二号文档独有内容\n';
async function addNestedDoc(root: string) {
  await mkdir(path.join(root, 'docs', '子'), { recursive: true });
  await writeFile(path.join(root, 'docs', '子', '二.md'), docTwo);
}
const notesWithDocs = '# 笔记\n\n## 需求文档\n\n- `docs/` 需求目录\n';

it('reqs 支持目录写法，递归展开的文档都进入模型', async () => {
  const { root } = await project(['docs/']);
  await addNestedDoc(root);
  const model = scriptedModel([finish([c1, c2])]);
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
  expect(prompt).toContain('docs/需求.md');
  expect(prompt).toContain('docs/子/二.md');
  expect(prompt).toContain('二号文档独有内容');
});

it('reqs 目录不存在或没有 .md 时退出 2 且不调用模型', async () => {
  const { root } = await project(['nothing/']);
  const model = scriptedModel([]);
  const out: string[] = [];
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(2);
  expect(out.join('\n')).toContain('没有 .md');
  expect(model.doGenerateCalls).toHaveLength(0);
});

it('config 的 requirementsDocs 为空时使用已确认笔记的需求文档小节', async () => {
  const { root, artifacts } = await project([]);
  await addNestedDoc(root);
  await artifacts.writeBytes('notes.md', Buffer.from(notesWithDocs));
  const approvals = await Approvals.load(artifacts);
  approvals.approve('notes', 'project', notesWithDocs, '人工');
  await approvals.save(artifacts);
  const model = scriptedModel([finish([c1, c2])]);
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain('docs/子/二.md');
});

it('笔记未确认时拒绝使用其需求文档小节，提示先审核笔记', async () => {
  const { root, artifacts } = await project([]);
  await artifacts.writeBytes('notes.md', Buffer.from(notesWithDocs));
  const model = scriptedModel([]);
  const out: string[] = [];
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(model) })).toBe(2);
  expect(out.join('\n')).toContain('review notes');
  expect(model.doGenerateCalls).toHaveLength(0);
});

it('config 的 requirementsDocs 非空时优先，忽略未确认的笔记小节', async () => {
  const { root, artifacts } = await project(['docs/需求.md']);
  await addNestedDoc(root);
  await artifacts.writeBytes('notes.md', Buffer.from(notesWithDocs));
  const model = scriptedModel([finish([c1, c2])]);
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: () => {}, dependencies: deps(model) })).toBe(0);
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toContain('二号文档独有内容');
});

it('两处都没有登记时提示 requirementsDocs 为空并说明笔记小节', async () => {
  const { root, artifacts } = await project([]);
  await artifacts.writeBytes('notes.md', Buffer.from('# 笔记\n\n## 需求文档\n\n未发现\n'));
  const out: string[] = [];
  expect(await cliMain(['reqs', '--module', 'M', '--project', root], { log: (s) => out.push(s), dependencies: deps(scriptedModel([])) })).toBe(2);
  expect(out.join('\n')).toContain('requirementsDocs 为空');
  expect(out.join('\n')).toContain('需求文档');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/cli/test/reqs-plan.test.ts --maxWorkers=1 --testTimeout=15000`
Expected: 新增的用例 FAIL（目录被当文件读取而报错；笔记小节未被使用），原有用例仍 PASS。

- [ ] **Step 3: 实现 `resolveRequirementEntries`**

把 `packages/cli/src/documents.ts` 顶部的导入改为（保留原有导入，新增下面几项）：

```ts
import { Approvals, decodeNotesUtf8, parseNotesRequirementDocs, type ArtifactStore } from '@crosscheck/core';
```

并在文件末尾追加（若文件顶部已有 `@crosscheck/core` 导入则合并为一行）：

```ts

export type RequirementEntries = { ok: true; entries: string[]; from: 'config' | 'notes' } | { ok: false; message: string };

const NOT_REGISTERED = 'requirementsDocs 为空：请在 config.yaml 的 requirementsDocs 登记需求文档，或在 notes.md 的“需求文档”小节登记并运行 crosscheck review notes 确认';

/** config 的 requirementsDocs 非空时优先；否则读取已确认笔记的“需求文档”小节。 */
export async function resolveRequirementEntries(artifacts: ArtifactStore, configured: string[]): Promise<RequirementEntries> {
  if (configured.length > 0) return { ok: true, entries: configured, from: 'config' };
  const bytes = await artifacts.readBytes('notes.md');
  if (bytes === undefined) return { ok: false, message: NOT_REGISTERED };
  let text: string;
  try { text = decodeNotesUtf8(bytes); }
  catch { return { ok: false, message: 'notes.md 不是有效的 UTF-8，请修复后重试' }; }
  const entries = parseNotesRequirementDocs(text);
  if (entries.length === 0) return { ok: false, message: NOT_REGISTERED };
  const approvals = await Approvals.load(artifacts);
  if (approvals.state('notes', 'project', text) !== 'approved') {
    return { ok: false, message: 'notes.md 的“需求文档”小节尚未确认：请先运行 crosscheck review notes 审核并确认笔记' };
  }
  return { ok: true, entries, from: 'notes' };
}
```

- [ ] **Step 4: 修改 `reqs.ts`**

把 `packages/cli/src/reqs.ts` 的导入补充：

```ts
import { createDiskDocLister, createProjectReader, expandRequirementDocs } from '@crosscheck/discovery';
```

并把原第 5 行改为：

```ts
import { readRequirementDocuments, resolveRequirementEntries } from './documents';
```

把原第 14-15 行：

```ts
    if (config.requirementsDocs.length === 0) { log('config.yaml 的 requirementsDocs 为空，请先登记需求文档'); return 2; }
    const documents = await readRequirementDocuments(args.project, config.requirementsDocs, sig);
```

替换为：

```ts
    const resolved = await resolveRequirementEntries(artifacts, config.requirementsDocs);
    if (!resolved.ok) { log(resolved.message); return 2; }
    let files: string[];
    try {
      files = await expandRequirementDocs(resolved.entries, createDiskDocLister(createProjectReader(args.project), (line) => log(redactor.text(line))), sig);
    } catch (error) {
      sig.throwIfAborted();
      log(redactor.text(error instanceof Error ? error.message : '需求文档展开失败'));
      return 2;
    }
    log(`需求文档来源：${resolved.from === 'config' ? 'config.yaml' : '已确认笔记'}，共 ${files.length} 个文件`);
    const documents = await readRequirementDocuments(args.project, files, sig);
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run packages/cli/test/reqs-plan.test.ts --maxWorkers=1 --testTimeout=15000`
Expected: 全部 PASS，包括原有的“reqs 空文档列表是门禁，缺失文档和父目录逃逸是宿主错误”（空列表断言 `requirementsDocs 为空`，缺失文件与 `..` 仍为退出 3）。

- [ ] **Step 6: 提交**

```bash
git add packages/cli/src/documents.ts packages/cli/src/reqs.ts packages/cli/test/reqs-plan.test.ts
git commit -m "feat(reqs): 支持目录写法并可从已确认笔记读取需求文档清单

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: init 提示词要求生成“需求文档”小节

**Files:**
- Modify: `packages/discovery/src/synthesize-notes.ts:9-19`（`NOTES_SYSTEM`）
- Test: `packages/discovery/test/synthesize-notes.test.ts`（在 `describe('项目笔记合成'` 块内追加用例）

**Interfaces:**
- Consumes: Task 1 的 `parseNotesRequirementDocs`（测试中用来验证约定格式可被解析）。
- Produces: `NOTES_SYSTEM` 新增对“## 需求文档”小节的要求；其他接口不变。

- [ ] **Step 1: 写失败的测试**

在 `packages/discovery/test/synthesize-notes.test.ts` 顶部导入处把 `@crosscheck/core` 的导入改为：

```ts
import { BudgetTracker, NotesTextSchema, parseNotesRequirementDocs } from '@crosscheck/core';
```

并在 `describe('项目笔记合成', () => {` 内第一个 `it` 之前插入：

```ts
  it('提示词要求生成可解析的“需求文档”小节', async () => {
    const { NOTES_SYSTEM } = await import('../src/index');
    expect(NOTES_SYSTEM).toContain('## 需求文档');
    expect(NOTES_SYSTEM).toContain('反引号');
    expect(NOTES_SYSTEM).toContain('未发现');
    // 提示词里的示例格式必须能被解析函数识别
    expect(parseNotesRequirementDocs('# 笔记\n\n## 需求文档\n\n- `docs/prd/` 产品需求\n')).toEqual(['docs/prd/']);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/discovery/test/synthesize-notes.test.ts --maxWorkers=1 --testTimeout=15000`
Expected: 新用例 FAIL（`NOTES_SYSTEM` 不含 `## 需求文档`）。

- [ ] **Step 3: 修改提示词**

在 `packages/discovery/src/synthesize-notes.ts` 的 `NOTES_SYSTEM` 数组里，`'旧笔记中人工补充的内容应在刷新时合并保留。',` 这一行之后、`'用 finish 提交，参数为 { markdown }。',` 之前插入：

```ts
  '笔记必须包含“## 需求文档”小节，列出疑似需求文档的 Markdown 文件或目录：每行写成“- `相对路径` 依据”，路径放在反引号内，目录以 / 结尾（如 `docs/prd/`），只列 .md 文档；',
  '不要列 node_modules、凭证、二进制或生成产物，路径必须来自你实际看到的目录与文件；没有发现需求文档时该小节只写一行“未发现”。',
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/discovery/test/synthesize-notes.test.ts --maxWorkers=1 --testTimeout=15000`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/discovery/src/synthesize-notes.ts packages/discovery/test/synthesize-notes.test.ts
git commit -m "feat(init): 笔记提示词要求生成需求文档小节

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: impact 识别目录与笔记小节（含基线侧 Git 展开）

**Files:**
- Modify: `packages/cli/src/impact/git.ts`（新增 `listTreeFiles`，加入返回对象）
- Modify: `packages/cli/src/impact/snapshot.ts:5-6,178-199`
- Modify: `packages/core/src/impact/dependencies.ts:55-62`
- Test: `packages/cli/test/impact-docs-dir.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `parseNotesRequirementDocs`；Task 2 `expandRequirementDocs`、`createDiskDocLister`、`parseDocEntry`、`DocDirLister`、`createProjectReader`。
- Produces: `openBaseline(...)` 返回对象新增 `listTreeFiles(dir: string): Promise<string[]>`：返回基线提交中 `dir` 之下常规 `.md` blob 的项目相对路径，并把它们登记进 `entries`（供 `raw('base', …)` 读取）。

- [ ] **Step 1: 写失败的测试**

新建 `packages/cli/test/impact-docs-dir.test.ts`：

```ts
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ImpactReport } from '@crosscheck/core';
import { cliMain } from '../src/main';
import { cleanupImpactRepos, impactPut as put, impactRepo as repo } from './impact-test-helper';

afterEach(cleanupImpactRepos);

async function analyze(root: string) {
  const lines: string[] = [];
  // 访问模型配置即抛错，确保 impact 完全不走模型路径。
  const dependencies = Object.defineProperty({}, 'modelOptions', { get() { throw new Error('不能加载模型'); } });
  await cliMain(['impact', '--project', root, '--json'], { log: (s) => lines.push(s), dependencies });
  return JSON.parse(lines[0]!) as ImpactReport;
}
const documentChanges = (report: ImpactReport) =>
  Object.fromEntries(report.changes.filter((change) => change.key.startsWith('document:')).map((change) => [change.key, change.kind]));

it('config 目录写法：目录内新增、修改、删除 .md 都被识别，非 .md 被忽略', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [docs/]');
  await put(root, 'docs/a.md', '甲'); await put(root, 'docs/sub/b.md', '乙'); await put(root, 'docs/sub/ignored.txt', '忽略');
  git('add', '.'); git('commit', '-m', '初始');
  await put(root, 'docs/sub/b.md', '乙改'); await put(root, 'docs/c.md', '丙'); git('add', 'docs/c.md');
  await rm(path.join(root, 'docs', 'a.md'));
  expect(documentChanges(await analyze(root))).toEqual({
    'document:docs/sub/b.md': 'modified', 'document:docs/c.md': 'added', 'document:docs/a.md': 'deleted',
  });
});

it('config 为空时使用笔记的需求文档小节', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: []');
  await put(root, '.crosscheck/notes.md', '# 笔记\n\n## 需求文档\n\n- `docs/` 需求\n');
  await put(root, 'docs/a.md', '甲');
  git('add', '.'); git('commit', '-m', '初始');
  await put(root, 'docs/a.md', '甲改');
  expect(documentChanges(await analyze(root))).toEqual({ 'document:docs/a.md': 'modified' });
});

it('基线中目录尚不存在时不报错，当前新增的文档识别为 added', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [docs/]');
  git('add', '.'); git('commit', '-m', '初始');
  await put(root, 'docs/x.md', '新'); git('add', 'docs/x.md');
  expect(documentChanges(await analyze(root))).toEqual({ 'document:docs/x.md': 'added' });
});

it('目录内文档变化会波及以它为来源的条款', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [docs/]');
  await put(root, 'docs/sub/b.md', '乙');
  await put(root, '.crosscheck/requirements/M.yaml', JSON.stringify([{ id: 'M-AC-1', text: '条款', source: { file: 'docs/sub/b.md', line: 1, excerpt: '乙' } }]));
  git('add', '.'); git('commit', '-m', '初始');
  await put(root, 'docs/sub/b.md', '乙改');
  const report = await analyze(root);
  expect(report.impacts.map((impact) => impact.key)).toContain('clause:M-AC-1');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/cli/test/impact-docs-dir.test.ts --maxWorkers=1 --testTimeout=15000`
Expected: 全部 FAIL（目录条目被当成文件，识别不到变化）。

- [ ] **Step 3: `git.ts` 新增 `listTreeFiles`**

在 `packages/cli/src/impact/git.ts` 中，`populate` 函数结束的 `}`（第 191 行）之后、`return { root, oid, entries, ...` 之前插入：

```ts
  // 基线侧展开需求文档目录：递归列出常规 .md blob，并登记进 entries 供后续读取。
  async function listTreeFiles(dir: string): Promise<string[]> {
    let remaining = LIMIT;
    const outputs = await batched([dir], ['ls-tree', '-r', '-z', '-l', '--full-tree', oid], async (args) => {
      let bytes: Buffer;
      try { bytes = await git(root, args, signal, remaining + 1); }
      catch (e) { if (e instanceof ImpactInputError || e instanceof ImpactHostError) throw e; throw new ImpactHostError('读取 Git 目录失败'); }
      remaining -= bytes.length;
      if (remaining < 0) throw new ImpactInputError('Git 清单超过资源上限');
      return bytes;
    });
    const files: string[] = [];
    for (const bytes of outputs) for (const record of decode(bytes)) {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(record);
      if (!match) throw new ImpactHostError('Git 树清单无效');
      const name = match[5]!;
      // 只收常规文件：符号链接（120000）、子模块等一律跳过。
      if (!name.startsWith(prefix) || match[2] !== 'blob' || (match[1] !== '100644' && match[1] !== '100755') || !/\.md$/i.test(name)) continue;
      const file = name.slice(prefix.length);
      entries.set(file, { mode: match[1]!, type: match[2]!, oid: match[3]!, size: match[4] === '-' ? 0 : Number(match[4]) });
      files.push(file);
    }
    return files;
  }
```

并把返回语句 `return { root, oid, entries, tracked, get candidatesLimited() { return candidatesLimited; }, populate, async blob(` 改为在 `populate,` 后加入 `listTreeFiles,`：

```ts
  return { root, oid, entries, tracked, get candidatesLimited() { return candidatesLimited; }, populate, listTreeFiles, async blob(entry: TreeEntry) {
```

- [ ] **Step 4: `snapshot.ts` 改为按清单来源展开**

(a) 把第 5-6 行的导入改为：

```ts
import { ModuleCasesSchema, ModuleClausesSchema, NotesTextSchema, decodeNotesUtf8, parseNotesRequirementDocs, PROFILE_FILES, PROFILE_SCHEMAS, ProfileSchema, ProjectConfigSchema, type ImpactSnapshot } from '@crosscheck/core';
import { createDiskDocLister, createProjectReader, expandRequirementDocs, isSafeProjectPath, parseDocEntry, type DocDirLister } from '@crosscheck/discovery';
```

(b) 把原第 178-194 行：

```ts
  for (const side of ['base', 'current'] as const) await parse(side, config, 'config');
  const docs = new Set<string>();
  for (const side of ['base', 'current'] as const) {
    const snap = side === 'base' ? base : current;
    const value = snap.nodes.find((n) => n.kind === 'config')?.value as { requirementsDocs?: string[] } | undefined;
    for (const file of value?.requirementsDocs ?? []) {
      if (!validPath(file)) {
        if (snap.diagnostics.length >= MAX_FILES) { fileLimit(); break; }
        diag(snap, 'restricted-input', '', '需求文档路径不安全'); continue;
      }
      const normalized = normalize(file);
      if (!normalized) { diag(snap, 'restricted-input', '', '需求文档路径不安全'); continue; }
      if (!admit(normalized)) break;
      declaredDocs[side].add(normalized); docs.add(normalized);
    }
  }
  await git.populate([...docs]);
```

替换为：

```ts
  // 笔记要先于需求文档解析：config 的 requirementsDocs 为空时，清单来自该侧笔记的“需求文档”小节。
  for (const side of ['base', 'current'] as const) { await parse(side, config, 'config'); await parse(side, notes, 'notes'); }
  const docs = new Set<string>();
  const docEntries = (snap: ImpactSnapshot): string[] => {
    const configured = (snap.nodes.find((n) => n.kind === 'config')?.value as { requirementsDocs?: string[] } | undefined)?.requirementsDocs ?? [];
    if (configured.length > 0) return configured;
    const text = snap.nodes.find((n) => n.kind === 'notes')?.value;
    return typeof text === 'string' ? parseNotesRequirementDocs(text) : [];
  };
  for (const side of ['base', 'current'] as const) {
    const snap = side === 'base' ? base : current;
    // 当前侧读磁盘，基线侧读 Git 对象；两侧共用同一套展开规则。目录允许为空：某一侧可能还没有该目录。
    const lister: DocDirLister = side === 'current' ? createDiskDocLister(createProjectReader(git.root)) : (dir) => git.listTreeFiles(dir);
    docs: for (const entry of docEntries(snap)) {
      let files: string[];
      if (parseDocEntry(entry).directory) {
        try { files = await expandRequirementDocs([entry], lister, signal, { allowEmpty: true }); }
        catch { abort(); diag(snap, 'restricted-input', '', '需求文档目录无法展开或超过上限'); continue; }
      } else files = [entry];
      for (const file of files) {
        if (!validPath(file)) {
          if (snap.diagnostics.length >= MAX_FILES) { fileLimit(); break docs; }
          diag(snap, 'restricted-input', '', '需求文档路径不安全'); continue;
        }
        const normalized = normalize(file);
        if (!normalized) { diag(snap, 'restricted-input', '', '需求文档路径不安全'); continue; }
        if (!admit(normalized)) break docs;
        declaredDocs[side].add(normalized); docs.add(normalized);
      }
    }
  }
  await git.populate([...docs]);
```

注意：`docs:` 作为标签与 `const docs` 变量同名但属于不同命名空间，合法；若团队不喜欢，可改标签为 `entries:` 并同步两处 `break docs`。

(c) 在原第 199 行，删除 `await parse(side, notes, 'notes');`（已在前面解析，重复调用会产生重复节点）。

- [ ] **Step 5: `dependencies.ts` 去掉只认 config 字符串的范围集合**

在 `packages/core/src/impact/dependencies.ts` 中，删除第 55-56 行：

```ts
  const configs = [...nodes.values()].filter((node) => node.kind === 'config');
  const scope = new Set(configs.flatMap((node) => list(obj(node.value).requirementsDocs)).map(normalizeSource).filter((x): x is string => !!x));
```

并删除第 62 行：

```ts
    if (!scope.has(normalized)) return;
```

理由：文档节点只会为已登记（含目录展开出）的文件创建，`documents.get(normalized)` 的命中本身就等价于“在登记范围内”；目录展开出的文件不会出现在 config 字符串里，原先的 `scope` 会把它们误排除。

- [ ] **Step 6: 运行确认通过**

Run: `pnpm vitest run packages/cli/test/impact-docs-dir.test.ts packages/cli/test/impact.test.ts packages/cli/test/impact-git.test.ts packages/core/test/impact-analysis.test.ts packages/core/test/impact.test.ts --maxWorkers=1 --testTimeout=15000`
Expected: 全部 PASS。

如果原有 impact 用例因节点顺序或 `scope` 移除而失败：先逐个读失败断言，判断是测试夹具依赖了“文档节点存在但未登记”，还是节点顺序变化（笔记节点现在先于文档节点）。**不要放宽断言来迁就**；若确属夹具依赖，调整夹具使其登记该文档，并在提交信息中说明。

- [ ] **Step 7: 类型检查并提交**

Run: `pnpm typecheck`
Expected: 无输出（通过）。

```bash
git add packages/cli/src/impact/git.ts packages/cli/src/impact/snapshot.ts packages/core/src/impact/dependencies.ts packages/cli/test/impact-docs-dir.test.ts
git commit -m "feat(impact): 识别需求文档目录与笔记小节，基线侧从 Git 展开

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 文档更新

**Files:**
- Modify: `README.md`（在第 47 行“扫描是预算内的最佳努力……”段落之后新增一段；并更新命令表里 `init` 与 `reqs` 的描述）
- Modify: `docs/manual-integration.md`（在提到 `requirementsDocs` 的位置补充同样内容）

- [ ] **Step 1: 定位**

Run: `grep -n "requirementsDocs" README.md docs/manual-integration.md`
记下 `docs/manual-integration.md` 中的相关行号，新增段落放在介绍该字段的位置之后。

- [ ] **Step 2: 写入 README 新段落**

在 README 第 47 行那一段之后插入：

```markdown
**需求文档登记：** `requirementsDocs` 可写文件，也可写以 `/` 结尾的目录（如 `docs/prd/`）。目录会递归展开其中的 `.md` 文件（不区分大小写），最多下探 8 层子目录、共 100 个文件，超限报错而不是截断；符号链接、凭证文件以及 `node_modules`、`.git`、`.crosscheck` 会被跳过；不支持 glob，显式写出的文件不限扩展名。`config.yaml` 的 `requirementsDocs` 为空时，`reqs` 与 `impact` 改读 `notes.md` 的“## 需求文档”小节（每行 ``- `路径` 说明``，路径在反引号内），此时笔记必须已通过 `review notes` 确认，`reqs` 才会使用它。`init` 会让模型在笔记里写出这一小节作为草稿，由你审核后生效；程序不会改写 `config.yaml`。`config.yaml` 中的 `requirementsDocs` 非空时始终优先。
```

- [ ] **Step 3: 更新命令表**

把 README 命令表中 `reqs --module <id>` 一行的用途改为：`从 requirementsDocs（支持目录）或已确认笔记的“需求文档”小节提取带来源的条款草稿`。`init` 一行的末尾补充：`笔记含“需求文档”小节草稿`。

- [ ] **Step 4: 写入 `docs/manual-integration.md`**

在 Step 1 记下的位置之后加入与 Step 2 相同的段落（标题或前缀按该文档风格调整）。

- [ ] **Step 5: 提交**

```bash
git add README.md docs/manual-integration.md
git commit -m "docs: 说明需求文档目录写法与笔记小节

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 全量验证

**Files:** 无改动。

- [ ] **Step 1: 类型检查与构建**

Run: `pnpm typecheck && pnpm build`
Expected: 均成功退出。

- [ ] **Step 2: 全量测试（低并发）**

Run: `pnpm vitest run --maxWorkers=1 --testTimeout=15000`
Expected: 0 失败。基线是 1667 通过、55 跳过；新增用例后通过数应增加，跳过数不变。

- [ ] **Step 3: 构建产物冒烟**

Run: `pnpm crosscheck --help`
Expected: 正常输出帮助。

- [ ] **Step 4: 对照规格自查**

逐条对照 `docs/superpowers/specs/2026-11-20-requirement-docs-discovery-design.md`：展开规则表、笔记小节、`init`/`reqs`/`impact` 行为、测试清单、文档，每项都能指到对应任务；有遗漏就补任务，不要口头带过。
