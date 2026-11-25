# init 一条命令完成笔记与画像 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `crosscheck init` 一条命令生成笔记并自动确认、生成七份画像、自动确认核验通过的 `api-catalog`/`pages`，其余画像在同一命令里交给人审核。

**Architecture:** `init` 先走现有笔记生成并以确认人 `auto` 写入确认记录；随后直接调用现有 `profileCommand` 生成画像；再用新增的条目来源核验函数剔除无证据条目，整份自动确认 `api-catalog`/`pages`；最后对仍未确认的画像，TTY 下调用 `reviewCommand`（带新增的 `only` 过滤），会话内通过 `deferReview` 回调交给会话打开审核视图，非 TTY 退出码 2。确认记录结构、`gate.ts` 都不改。

**Tech Stack:** TypeScript、pnpm workspace、vitest、Ink（TUI）、zod。

**Spec:** `docs/superpowers/specs/2026-11-23-init-all-in-one-design.md`

## Global Constraints

- 所有对话、文档、代码注释使用中文。
- 确认记录结构不变（`hash`、`by`、`at`）；自动确认即 `by === 'auto'`，常量 `AUTO_REVIEWER = 'auto'`。
- 自动确认只用于 `notes`、`api-catalog.yaml`、`pages.yaml`；`environments.yaml`、`auth.yaml`、`data-model.yaml`、`fixtures.yaml`、`guardrails.yaml` 永不自动确认。
- 不改 `packages/core/src/workflow/gate.ts`，不改 `reqs → plan → run` 的人工门禁。
- 非 TTY 下待确认清单以退出码 2 结束（与 `review` 非 TTY 现有约定一致）。
- 并发修改检测沿用现有"生成期间文件或确认记录被改则停止"的做法，不放宽。
- 测试命令：`pnpm test`（全量）、`pnpm vitest run <文件>`（单文件）、`pnpm typecheck`。

## 与 spec 的差异（实现时的取舍）

- spec 写"把 profile 生成逻辑抽成可复用函数"。实际 `profileCommand(args, log, deps, signal)` 本身已可被直接调用（`withInterrupt` 支持嵌套并传入信号），因此 `init` 直接调用它，不做抽取。
- spec 写"`/status` 显示确认来源"。`/status` 只显示数量，没有逐项列表，所以不改；确认来源显示在 `review profile` 的画像列表中。
- `api-catalog`/`pages` 核验后条目全部被剔除（或原本就为空）时，不修改文件、不确认，交给人审核。
- 已知限制：若 `fixtures.yaml` 的 http fixture 引用了被剔除的 operation，`review` 在全部确认后会显示"交叉校验未通过"，由人处理。

## 文件结构

| 文件 | 责任 |
|---|---|
| `packages/discovery/src/verify-entry-sources.ts`（新） | 逐条核验画像条目的 `sources`，返回保留与剔除 |
| `packages/core/src/approvals/reviewer.ts` | 新增 `AUTO_REVIEWER` |
| `packages/cli/src/args.ts` | `init` 接受 `--openapi`；`CliArgs.only` |
| `packages/cli/src/context.ts` | `CommandDependencies.init.deferReview` |
| `packages/cli/src/init.ts` | 编排笔记、画像、自动确认、审核 |
| `packages/cli/src/review.ts` | 把 `args.only` 传给 `runReview` |
| `packages/cli/src/session.ts` | 会话中 `/init` 结束后打开只含待确认画像的审核视图 |
| `packages/tui/src/routes.ts`、`app.tsx`、`views/profile.tsx`、`state/profile.ts`、`index.ts`、`session.tsx` | `only` 过滤与确认人显示 |
| `README.md`、`docs/manual-integration.md` | 流程说明 |

---

### Task 1: 画像条目来源核验函数

**Files:**
- Create: `packages/discovery/src/verify-entry-sources.ts`
- Modify: `packages/discovery/src/index.ts`
- Test: `packages/discovery/test/verify-entry-sources.test.ts`

**Interfaces:**
- Consumes: `createProjectReader`、`isSafeProjectPath`（`./files`）、`readCleanLines`、`TextCleaner`（`./project-tools`）、`FileEntry`（`./walk`）
- Produces:
  ```ts
  export interface EntrySource { file: string; line: number; excerpt: string }
  export interface DroppedEntry { name: string; reason: string }
  export function verifyEntrySources<T extends { sources: readonly EntrySource[] }>(options: {
    projectRoot: string; files: readonly FileEntry[]; entries: Record<string, T>;
    clean?: TextCleaner; signal?: AbortSignal;
  }): Promise<{ kept: Record<string, T>; dropped: DroppedEntry[] }>
  ```
  规则：条目至少有一个来源满足「路径安全且在 `files` 登记范围内、`line` 在文件行数内、清洗后的该行去空白后包含 `excerpt` 去空白后的内容」才保留；保持原条目顺序。

- [ ] **Step 1: 写失败测试**

```ts
// packages/discovery/test/verify-entry-sources.test.ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { verifyEntrySources, walkProject } from '../src/index';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'entry-sources-'));
  await mkdir(join(root, 'server'));
  await writeFile(join(root, 'server/users.controller.ts'), "@Controller('users')\nexport class Users {\n  @Get(':id')\n  find() {}\n}\n");
  await writeFile(join(root, '.env'), 'API_TOKEN=real\n');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const entry = (file: string, line: number, excerpt: string) => ({ sources: [{ file, line, excerpt }] });
async function verify(entries: Record<string, { sources: { file: string; line: number; excerpt: string }[] }>) {
  return verifyEntrySources({ projectRoot: root, files: (await walkProject(root)).files, entries });
}

it('来源行包含摘录则保留，保持原顺序', async () => {
  const result = await verify({ b: entry('server/users.controller.ts', 3, "@Get(':id')"), a: entry('server/users.controller.ts', 1, '@Controller') });
  expect(Object.keys(result.kept)).toEqual(['b', 'a']);
  expect(result.dropped).toEqual([]);
});

it('多个来源只要一个通过就保留', async () => {
  const result = await verify({ x: { sources: [{ file: 'server/users.controller.ts', line: 1, excerpt: '虚构' }, { file: 'server/users.controller.ts', line: 3, excerpt: '@Get' }] } });
  expect(Object.keys(result.kept)).toEqual(['x']);
});

it.each([
  ['文件不存在', entry('server/none.ts', 1, 'x')],
  ['行号越界', entry('server/users.controller.ts', 99, '@Get')],
  ['摘录不符', entry('server/users.controller.ts', 2, '@Get')],
  ['路径越出项目', entry('../outside.ts', 1, 'x')],
  ['凭证文件不在登记范围', entry('.env', 1, 'API_TOKEN')],
  ['摘录为空', entry('server/users.controller.ts', 1, '   ')],
])('%s 时剔除并给出原因', async (_name, value) => {
  const result = await verify({ bad: value });
  expect(result.kept).toEqual({});
  expect(result.dropped).toHaveLength(1);
  expect(result.dropped[0]!.name).toBe('bad');
  expect(result.dropped[0]!.reason).toContain('来源核验失败');
});

it('清洗函数先于比较生效', async () => {
  const result = await verifyEntrySources({
    projectRoot: root, files: (await walkProject(root)).files,
    entries: { x: entry('server/users.controller.ts', 3, '@Hidden(":id")') },
    clean: (text) => text.replace('@Get', '@Hidden').replace("':id'", '":id"'),
  });
  expect(Object.keys(result.kept)).toEqual(['x']);
});

it('已取消时抛出', async () => {
  await expect(verifyEntrySources({ projectRoot: root, files: [], entries: { x: entry('a', 1, 'a') }, signal: AbortSignal.abort() })).rejects.toThrow();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/discovery/test/verify-entry-sources.test.ts`
Expected: FAIL（`verifyEntrySources` 未导出）

- [ ] **Step 3: 实现**

```ts
// packages/discovery/src/verify-entry-sources.ts
import { createProjectReader, isSafeProjectPath } from './files';
import { readCleanLines, type TextCleaner } from './project-tools';
import type { FileEntry } from './walk';

export interface EntrySource { file: string; line: number; excerpt: string }
export interface DroppedEntry { name: string; reason: string }

/** 逐条核验画像条目的来源：宿主重读文件，任一来源的清洗后行包含摘录才保留。口径与 verifyFindings 一致。 */
export async function verifyEntrySources<T extends { sources: readonly EntrySource[] }>(options: {
  projectRoot: string;
  files: readonly FileEntry[];
  entries: Record<string, T>;
  clean?: TextCleaner;
  signal?: AbortSignal;
}): Promise<{ kept: Record<string, T>; dropped: DroppedEntry[] }> {
  const reader = createProjectReader(options.projectRoot);
  const clean = options.clean ?? ((text: string) => text);
  const listed = new Set(options.files.map((file) => file.path));
  const cache = new Map<string, string[] | undefined>();
  const kept: Record<string, T> = {};
  const dropped: DroppedEntry[] = [];
  for (const [name, entry] of Object.entries(options.entries)) {
    options.signal?.throwIfAborted();
    let passed = false;
    for (const source of entry.sources) {
      const file = source.file.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
      if (!isSafeProjectPath(file) || !listed.has(file)) continue;
      if (!cache.has(file)) {
        try { cache.set(file, await readCleanLines(reader, file, options.signal, clean)); }
        catch { options.signal?.throwIfAborted(); cache.set(file, undefined); }
      }
      const text = cache.get(file)?.[source.line - 1]?.trim();
      const excerpt = source.excerpt.trim();
      if (text && excerpt && text.includes(excerpt)) { passed = true; break; }
    }
    if (passed) kept[name] = entry;
    else {
      const first = entry.sources[0];
      dropped.push({ name, reason: `来源核验失败${first ? `：${first.file}:${first.line}` : ''}` });
    }
  }
  return { kept, dropped };
}
```

在 `packages/discovery/src/index.ts` 末尾追加：

```ts
export { verifyEntrySources } from './verify-entry-sources';
export type { DroppedEntry, EntrySource } from './verify-entry-sources';
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/discovery/test/verify-entry-sources.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/discovery/src/verify-entry-sources.ts packages/discovery/src/index.ts packages/discovery/test/verify-entry-sources.test.ts
git commit -m "feat(discovery): 新增画像条目来源核验"
```

---

### Task 2: 自动确认人常量、init 参数与依赖类型

**Files:**
- Modify: `packages/core/src/approvals/reviewer.ts`
- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/src/context.ts`
- Test: `packages/cli/test/init.test.ts`（追加）、`packages/core/test/approvals.test.ts`（追加）

**Interfaces:**
- Produces:
  - `export const AUTO_REVIEWER = 'auto'`（`@crosscheck/core`，经 `reviewer.ts` 已被 `index.ts` 导出）
  - `CliArgs.only?: ProfileFile[]`
  - `CommandDependencies.init?: { deferReview?: (only: ProfileFile[]) => void }`
  - `init` 命令接受可重复的 `--openapi`

- [ ] **Step 1: 写失败测试**

在 `packages/core/test/approvals.test.ts` 追加（文件已有 `Approvals` 导入则复用，否则补 `import { Approvals, AUTO_REVIEWER } from '../src/index';`）：

```ts
it('自动确认人常量固定为 auto，确认记录可区分', () => {
  expect(AUTO_REVIEWER).toBe('auto');
  const approvals = Approvals.empty();
  approvals.approve('notes', 'project', '# 笔记', AUTO_REVIEWER);
  expect(approvals.record('notes', 'project')?.by).toBe('auto');
});
```

在 `packages/cli/test/init.test.ts` 末尾追加：

```ts
import { parseArgs } from '../src/main';

it('init 接受可重复的 --openapi 并去重', () => {
  expect(parseArgs(['init', '--openapi', 'a.yaml', '--openapi', 'b.yaml', '--openapi', 'a.yaml']).openapi).toEqual(['a.yaml', 'b.yaml']);
  expect(() => parseArgs(['init', '--module', 'M'])).toThrow();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/core/test/approvals.test.ts packages/cli/test/init.test.ts -t "自动确认人|--openapi"`
Expected: FAIL（常量未定义；`init` 不接受 `--openapi`）

- [ ] **Step 3: 实现**

`packages/core/src/approvals/reviewer.ts` 顶部（`import os` 之后）加入：

```ts
/** 宿主核验后自动确认时写入确认记录的确认人；`review` 界面据此区分自动与人工确认。 */
export const AUTO_REVIEWER = 'auto';
```

`packages/cli/src/args.ts`：
- 首行改为 `import { CaseIdSchema, ProfileNameSchema, type ProfileFile } from '@crosscheck/core';`
- `CliArgs` 增加 `only?: ProfileFile[];`（放在 `json?: boolean;` 之后）
- `FLAGS.init` 改为 `['--refresh', '--openapi', '--project']`
- `REPEATABLE.init` 改为 `['--openapi']`
- `HELP` 里 `crosscheck init [--refresh] [--project <目录>]` 改为 `crosscheck init [--refresh] [--openapi <文件>]... [--project <目录>]`
- `HELP` 里 `init 生成笔记，profile 基于已确认笔记和结构化扫描生成画像；init/profile/reqs/plan 只写草稿，不自动确认；确认只能在 review 中由人完成。` 改为：
  `init 生成并自动确认笔记，生成七份画像，自动确认来源核验通过的 api-catalog 与 pages，其余画像进入 review 由人确认；profile 可单独重跑画像；reqs/plan 只写草稿，条款与用例只能在 review 中由人确认。`

`packages/cli/src/context.ts`：
- 第一行 `import { loadUserModelConfig, ... }` 的类型导入增加 `type ProfileFile`
- `CommandDependencies` 改为：

```ts
export type CommandDependencies = Pick<RunSuiteOptions, 'modelOptions' | 'resilience' | 'env' | 'userConfigHome'> & {
  review?: ReviewDependencies;
  session?: { isTTY?: boolean };
  /** 会话内 /init 使用：提供后 init 不自己打开审核，而是把待确认画像交给会话。 */
  init?: { deferReview?: (only: ProfileFile[]) => void };
};
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/core/test/approvals.test.ts packages/cli/test/init.test.ts -t "自动确认人|--openapi" && pnpm typecheck`
Expected: PASS，类型检查无错误

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/approvals/reviewer.ts packages/cli/src/args.ts packages/cli/src/context.ts packages/core/test/approvals.test.ts packages/cli/test/init.test.ts
git commit -m "feat(init): 新增自动确认人常量、--openapi 参数与审核回调类型"
```

---

### Task 3: 审核界面支持只列指定画像并显示确认人

**Files:**
- Modify: `packages/tui/src/routes.ts`
- Modify: `packages/tui/src/app.tsx`
- Modify: `packages/tui/src/views/profile.tsx`
- Modify: `packages/tui/src/state/profile.ts`
- Modify: `packages/tui/src/index.ts`
- Modify: `packages/tui/src/session.tsx`
- Modify: `packages/cli/src/review.ts`
- Test: `packages/tui/test/profile-only.test.ts`（新）

**Interfaces:**
- Produces:
  - `Route` 的 `profile` 变体：`{ name: 'profile'; only?: ProfileFile[] }`
  - `initialRoute(view?, module?, runId?, only?: ProfileFile[])`
  - `loadProfileOverview(session, only?: readonly ProfileFile[])`；`ProfileRow.by?: string`（仅状态为 `approved` 时有值）；`rows` 按 `only` 过滤，`crossCheck` 仍基于全部七份计算
  - `RunReviewOptions.only?: ProfileFile[]`
  - `SlashCommandResult` 的 `review` 变体：`args` 增加 `only?: ProfileFile[]`，并新增可选 `lines?: string[]`（进入审核前先追加到会话记录）

- [ ] **Step 1: 写失败测试**

```ts
// packages/tui/test/profile-only.test.ts
import { afterEach, expect, it } from 'vitest';
import { AUTO_REVIEWER, readProfileFile } from '@crosscheck/core';
import { initialRoute, loadProfileOverview } from '../src/index';
import { cleanupProjects, createProject } from './fixture';

afterEach(cleanupProjects);

it('only 过滤行，未过滤时七份齐全', async () => {
  const { session } = await createProject();
  expect((await loadProfileOverview(session)).rows).toHaveLength(7);
  const only = await loadProfileOverview(session, ['auth.yaml', 'guardrails.yaml']);
  expect(only.rows.map((row) => row.name)).toEqual(['auth.yaml', 'guardrails.yaml']);
});

it('已确认行带确认人，auto 与人工可区分；未确认行没有确认人', async () => {
  const { session, artifacts } = await createProject();
  const file = await readProfileFile(artifacts, 'pages.yaml');
  if (!file.present || !file.ok) throw new Error('画像无效');
  await session.mutate((approvals) => approvals.approve('profile', 'pages.yaml', file.value, AUTO_REVIEWER));
  const overview = await loadProfileOverview(session);
  expect(overview.rows.find((row) => row.name === 'pages.yaml')).toMatchObject({ status: 'approved', by: 'auto' });
  expect(overview.rows.find((row) => row.name === 'auth.yaml')?.by).toBeUndefined();
});

it('过滤后交叉校验仍基于全部七份', async () => {
  const { session, artifacts } = await createProject();
  for (const name of ['environments.yaml', 'auth.yaml', 'api-catalog.yaml', 'pages.yaml', 'data-model.yaml', 'fixtures.yaml', 'guardrails.yaml'] as const) {
    const file = await readProfileFile(artifacts, name);
    if (!file.present || !file.ok) throw new Error('画像无效');
    await session.mutate((approvals) => approvals.approve('profile', name, file.value, '人工'));
  }
  const overview = await loadProfileOverview(session, ['auth.yaml']);
  expect(overview.rows).toHaveLength(1);
  expect(overview.crossCheck).toBeUndefined();
});

it('initialRoute 把 only 带入画像路由', () => {
  expect(initialRoute('profile', undefined, undefined, ['auth.yaml'])).toEqual({ name: 'profile', only: ['auth.yaml'] });
  expect(initialRoute('profile')).toEqual({ name: 'profile' });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/tui/test/profile-only.test.ts`
Expected: FAIL（`only` 参数与 `by` 字段不存在，`initialRoute` 返回值不含 `only`）

- [ ] **Step 3: 实现**

`packages/tui/src/routes.ts`：
- 文件顶部 `import type { Key } from 'ink';` 之后加 `import type { ProfileFile } from '@crosscheck/core';`
- `Route` 中 `| { name: 'profile' }` 改为 `| { name: 'profile'; only?: ProfileFile[] }`
- `initialRoute` 签名改为 `initialRoute(view?: ReviewView, module?: string, runId?: string, only?: ProfileFile[]): Route`
- `case 'profile'` 改为 `return only?.length ? { name: 'profile', only } : { name: 'profile' };`

`packages/tui/src/app.tsx`：`case 'profile'` 改为 `return <ProfileView nav={nav} only={route.only} />;`

`packages/tui/src/state/profile.ts`：
- `ProfileRow` 改为 `export interface ProfileRow { name: ProfileFile; status: ProfileRowStatus; by?: string; error?: string; details: string[] }`
- `loadProfileOverview` 签名改为 `(session: ReadonlyReviewContext, only?: readonly ProfileFile[])`
- 正常行（`rows.push({ name: file.name, status: session.approvals.state(...) ...`）改为先算状态再推入：

```ts
    const status = session.approvals.state('profile', file.name, file.value);
    rows.push({
      name: file.name, status,
      ...(status === 'approved' ? { by: session.approvals.record('profile', file.name)?.by } : {}),
      details: ['审批载荷（含 schema 默认值）', ...YAML.stringify(file.value, { lineWidth: 0 }).split('\n')],
    });
```
- 函数末尾 `return { rows, crossCheck };` 改为 `return { rows: only ? rows.filter((row) => only.includes(row.name)) : rows, crossCheck };`（`crossCheck` 的计算保持在过滤之前，基于全部行）

`packages/tui/src/views/profile.tsx`：
- 签名改为 `export function ProfileView({ nav, only }: { nav: Nav; only?: readonly ProfileFile[] })`，并 `import type { ProfileFile } from '@crosscheck/core';`
- `useLoader(() => loadProfileOverview(session), [session])` 改为 `useLoader(() => loadProfileOverview(session, only), [session, only])`
- 列表项 label 改为 `` `${r.name.padEnd(18)} ${APPROVAL_LABEL[r.status]}${r.by ? ` · ${r.by}` : ''}` ``

`packages/tui/src/index.ts`：`RunReviewOptions` 增加 `only?: ProfileFile[];`（`import type { ArtifactStore, ProfileFile } from '@crosscheck/core';`），`initialRoute(options.view, options.module, options.runId)` 改为 `initialRoute(options.view, options.module, options.runId, options.only)`。

`packages/tui/src/session.tsx`：
- `SlashCommandResult` 的 review 变体改为 `{ kind: 'review'; args: { project: string; view?: ReviewView; modules?: string[]; runId?: string; only?: ProfileFile[] }; lines?: string[] }`（顶部补 `import type { ProfileFile } from '@crosscheck/core';`）
- `if (result.kind === 'review') {` 之后第一行加：`if (result.lines?.length) append('assistant', result.lines.join('\n'));`
- 第 213 行 `initialRoute(review.args.view, review.args.modules?.[0], review.args.runId)` 改为 `initialRoute(review.args.view, review.args.modules?.[0], review.args.runId, review.args.only)`

`packages/cli/src/review.ts`：`runReview({...})` 参数里 `view: args.view, module: ...` 之后加 `only: args.only,`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/tui packages/cli/test/review.test.ts && pnpm typecheck`
Expected: PASS（既有 TUI 与 review 测试不受影响）

- [ ] **Step 5: 提交**

```bash
git add packages/tui packages/cli/src/review.ts
git commit -m "feat(tui): 画像审核支持只列指定画像并显示确认人"
```

---

### Task 4: init 编排：笔记自动确认、画像生成、条目核验、审核交接

**Files:**
- Modify: `packages/cli/src/init.ts`
- Modify: `packages/cli/src/session.ts`
- Test: `packages/cli/test/init-all-in-one.test.ts`（新）；修改 `packages/cli/test/init.test.ts` 中受影响的既有用例

**Interfaces:**
- Consumes: Task 1 `verifyEntrySources`；Task 2 `AUTO_REVIEWER`、`CliArgs.only`、`deps.init.deferReview`；Task 3 的 `reviewCommand` 已传递 `only`；`profileCommand(args, log, deps, signal)`；`readProfileFile`/`readProfileFiles`（core）
- Produces: `initCommand` 新行为（退出码见下）；会话 `/init` 返回 `{ kind: 'review', args: { project, view: 'profile', only }, lines }`

**退出码：** 笔记或画像生成失败 → 2（沿用）；全部确认完成 → 0；非 TTY 且仍有待确认 → 2；TTY 审核结束 → 沿用 `review` 的退出码（`q`/`Esc` 为 0，Ctrl+C 为 2）；会话内交给会话 → 0。

- [ ] **Step 1: 写失败测试**

```ts
// packages/cli/test/init-all-in-one.test.ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AUTO_REVIEWER, Approvals, ArtifactStore, PROFILE_FILES, readProfileFile, readProfileFiles } from '@crosscheck/core';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import { cliMain as realCliMain } from '../src/main';

const cliMain: typeof realCliMain = (argv, options = {}) => {
  const index = argv.indexOf('--project');
  return realCliMain(argv, { ...options, dependencies: { ...options.dependencies, userConfigHome: index >= 0 ? path.join(argv[index + 1]!, 'user') : undefined } });
};
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

const SOURCE = { file: 'server/users.ts', line: 1, excerpt: "@Get('users')" };
const FAKE = { file: 'server/users.ts', line: 1, excerpt: '虚构内容' };
const op = (source: typeof SOURCE) => ({ environment: 'local', method: 'GET', path: '/users', description: '用户列表', sources: [source] });
const page = (source: typeof SOURCE) => ({ environment: 'local', path: '/users', description: '用户页', sources: [source] });
const FILES = {
  'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:3000', healthcheck: 'http://localhost:3000/health', reset: null } } },
  'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } },
  'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: {} },
  'guardrails.yaml': { allowedHosts: ['localhost:3000'] },
};
const finish = (input: Record<string, unknown>): ScriptStep => ({ toolCalls: [{ name: 'finish', input }] });
/** 笔记 → 探索 → 五步画像；apiCatalog/pages 可替换以构造核验场景。 */
function script(apiCatalog: unknown, pages: unknown): ScriptStep[] {
  return [
    finish({ markdown: '# 项目笔记\n\n扫描结果' }),
    finish({ findings: [] }),
    finish({ 'environments.yaml': FILES['environments.yaml'] }),
    finish({ 'auth.yaml': FILES['auth.yaml'] }),
    finish({ 'api-catalog.yaml': apiCatalog, 'pages.yaml': pages }),
    finish({ 'data-model.yaml': FILES['data-model.yaml'], 'fixtures.yaml': FILES['fixtures.yaml'] }),
    finish({ 'guardrails.yaml': FILES['guardrails.yaml'] }),
  ];
}
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cli-init-all-')); roots.push(root);
  const artifacts = new ArtifactStore(root);
  await mkdir(path.join(root, 'user', '.crosscheck'), { recursive: true });
  await writeFile(path.join(root, 'user', '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' }, providers: { mock: { type: 'openai', baseURL: 'https://example.invalid/v1', apiKey: 'fixture-key' } } }));
  await artifacts.writeYaml('config.yaml', {});
  await mkdir(path.join(root, 'server'));
  await writeFile(path.join(root, 'server/users.ts'), "@Get('users')\nexport const list = () => [];\n");
  return { root, artifacts };
}
const deps = (model: ReturnType<typeof scriptedModel>, extra: Record<string, unknown> = {}) => ({ modelOptions: { env: {}, factories: { openai: () => model } }, resilience: { retries: 0, baseDelayMs: 0 }, ...extra });
const nonTty = { review: { isTTY: false } };

it('笔记自动确认，api-catalog/pages 核验通过后自动确认，其余五份留给人，非 TTY 退出 2', async () => {
  const { root, artifacts } = await project();
  const model = scriptedModel(script({ version: 1, operations: { list_users: op(SOURCE) } }, { version: 1, pages: { users: page(SOURCE) } }));
  const out: string[] = [];
  expect(await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: deps(model, nonTty) })).toBe(2);
  const approvals = await Approvals.load(artifacts);
  expect(approvals.record('notes', 'project')?.by).toBe(AUTO_REVIEWER);
  expect(approvals.record('profile', 'api-catalog.yaml')?.by).toBe(AUTO_REVIEWER);
  expect(approvals.record('profile', 'pages.yaml')?.by).toBe(AUTO_REVIEWER);
  for (const name of ['environments.yaml', 'auth.yaml', 'data-model.yaml', 'fixtures.yaml', 'guardrails.yaml']) expect(approvals.record('profile', name)).toBeUndefined();
  expect(out.join('\n')).toContain('environments.yaml');
  expect(out.join('\n')).toContain('review profile');
});

it('核验未通过的条目被剔除并汇总，剩余内容整份自动确认', async () => {
  const { root, artifacts } = await project();
  const model = scriptedModel(script({ version: 1, operations: { list_users: op(SOURCE), fake_op: op(FAKE) } }, { version: 1, pages: { users: page(SOURCE) } }));
  const out: string[] = [];
  await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: deps(model, nonTty) });
  const file = await readProfileFile(artifacts, 'api-catalog.yaml');
  if (!file.present || !file.ok) throw new Error('画像无效');
  expect(Object.keys((file.value as { operations: object }).operations)).toEqual(['list_users']);
  expect((await Approvals.load(artifacts)).state('profile', 'api-catalog.yaml', file.value)).toBe('approved');
  expect(out.join('\n')).toContain('fake_op');
});

it('条目全部未通过核验时不修改文件、不自动确认，并列入待人工确认', async () => {
  const { root, artifacts } = await project();
  const model = scriptedModel(script({ version: 1, operations: { fake_op: op(FAKE) } }, { version: 1, pages: {} }));
  const out: string[] = [];
  await cliMain(['init', '--project', root], { log: (s) => out.push(s), dependencies: deps(model, nonTty) });
  const approvals = await Approvals.load(artifacts);
  expect(approvals.record('profile', 'api-catalog.yaml')).toBeUndefined();
  expect(approvals.record('profile', 'pages.yaml')).toBeUndefined();
  const file = await readProfileFile(artifacts, 'api-catalog.yaml');
  expect(file.present && file.ok && Object.keys((file.value as { operations: object }).operations)).toEqual(['fake_op']);
  expect(out.join('\n')).toMatch(/api-catalog\.yaml.*pages\.yaml|pages\.yaml.*api-catalog\.yaml/s);
});

it('TTY 下进入审核，只列待确认的画像，并透传给 review', async () => {
  const { root } = await project();
  const model = scriptedModel(script({ version: 1, operations: { list_users: op(SOURCE) } }, { version: 1, pages: { users: page(SOURCE) } }));
  const runReview = vi.fn(async () => 0);
  const code = await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model, { review: { isTTY: true, userInfo: () => ({ username: '测试人' }), runReview } }) });
  expect(code).toBe(0);
  expect(runReview).toHaveBeenCalledTimes(1);
  const options = runReview.mock.calls[0]![0] as { view?: string; only?: string[] };
  expect(options.view).toBe('profile');
  expect(options.only).toEqual(['environments.yaml', 'auth.yaml', 'data-model.yaml', 'fixtures.yaml', 'guardrails.yaml']);
});

it('提供 deferReview 时不自己审核，把待确认清单交给调用方', async () => {
  const { root } = await project();
  const model = scriptedModel(script({ version: 1, operations: { list_users: op(SOURCE) } }, { version: 1, pages: { users: page(SOURCE) } }));
  const runReview = vi.fn(async () => 0);
  const deferred: string[][] = [];
  const code = await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model, { review: { isTTY: false, runReview }, init: { deferReview: (only: string[]) => deferred.push(only) } }) });
  expect(code).toBe(0);
  expect(runReview).not.toHaveBeenCalled();
  expect(deferred).toEqual([['environments.yaml', 'auth.yaml', 'data-model.yaml', 'fixtures.yaml', 'guardrails.yaml']]);
});

it('已确认的笔记与画像重跑时跳过生成，不调用模型', async () => {
  const { root, artifacts } = await project();
  const first = scriptedModel(script({ version: 1, operations: { list_users: op(SOURCE) } }, { version: 1, pages: { users: page(SOURCE) } }));
  await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(first, nonTty) });
  // 人工确认剩余五份
  const approvals = await Approvals.load(artifacts);
  for (const file of await readProfileFiles(artifacts)) if (file.present && file.ok && !approvals.record('profile', file.name)) approvals.approve('profile', file.name, file.value, '人工');
  await approvals.save(artifacts);
  const second = scriptedModel([]);
  expect(await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(second, nonTty) })).toBe(0);
  expect(second.doGenerateCalls).toHaveLength(0);
});

it('自动确认后编辑文件，确认失效', async () => {
  const { root, artifacts } = await project();
  const model = scriptedModel(script({ version: 1, operations: { list_users: op(SOURCE) } }, { version: 1, pages: { users: page(SOURCE) } }));
  await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model, nonTty) });
  await artifacts.writeYaml('system/pages.yaml', { version: 1, pages: { users: { ...page(SOURCE), description: '被人改过' } } });
  const file = await readProfileFile(artifacts, 'pages.yaml');
  if (!file.present || !file.ok) throw new Error('画像无效');
  expect((await Approvals.load(artifacts)).state('profile', 'pages.yaml', file.value)).toBe('stale');
});

it('init 之后 reqs/plan/run 的人工门禁不变：条款与用例仍未确认', async () => {
  const { root, artifacts } = await project();
  const model = scriptedModel(script({ version: 1, operations: { list_users: op(SOURCE) } }, { version: 1, pages: { users: page(SOURCE) } }));
  await cliMain(['init', '--project', root], { log: () => {}, dependencies: deps(model, nonTty) });
  const approvals = await Approvals.load(artifacts);
  expect([...PROFILE_FILES].filter((name) => approvals.record('profile', name)?.by === AUTO_REVIEWER)).toEqual(['api-catalog.yaml', 'pages.yaml']);
  expect(await artifacts.readBytes('clauses/')).toBeUndefined();
});
```

> 最后一个用例的最后一行断言只是确认 `init` 没有生成任何条款目录。如 `ArtifactStore` 对目录路径的 `readBytes` 会抛错，请改为 `await expect(artifacts.loadClauses('M')).resolves.toEqual([])`（以 `ArtifactStore` 实际的条款读取方法为准，先 `grep -n "Clauses" packages/core/src/store/artifact-store.ts` 确认）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/cli/test/init-all-in-one.test.ts`
Expected: FAIL（`init` 只写笔记草稿，没有后续步骤）

- [ ] **Step 3: 实现 `packages/cli/src/init.ts`**

整体改为：保留现有导出 `NOTES_FILE`、`CONFIG_TEMPLATE`；把现有函数体里"笔记生成"部分原样移入 `generateNotes`，`initCommand` 负责串联。

```ts
import {
  AUTO_REVIEWER, Approvals, ArtifactStore, BudgetTracker, PROFILE_FILES, decodeNotesUtf8, NotesTextSchema, ProjectConfigSchema,
  readProfileFile, readProfileFiles, type ProfileFile,
} from '@crosscheck/core';
import { synthesizeNotes, verifyEntrySources, walkProject } from '@crosscheck/discovery';
import { sanitizeMultiline } from '@crosscheck/discovery/sanitize';
import type { CliArgs } from './args';
import { loadModelContext, resolveModels, withCliProgress, withInterrupt, type CommandDependencies } from './context';
import { profileCommand } from './profile';
import { reviewCommand } from './review';

export const NOTES_FILE = 'notes.md';
export const CONFIG_TEMPLATE = {
  budget: { perCase: { steps: 60, tokens: 400000, minutes: 10 } },
  requirementsDocs: [] as string[],
};

type Logger = (s: string) => void;
/** 自动确认的画像：条目带 sources，可由宿主逐条核验。其余画像永不自动确认。 */
const VERIFIABLE = [
  { name: 'api-catalog.yaml', key: 'operations' },
  { name: 'pages.yaml', key: 'pages' },
] as const;

export async function initCommand(args: CliArgs, log: Logger, deps: CommandDependencies = {}, signal?: AbortSignal): Promise<number> {
  return withInterrupt(signal, async (sig) => {
    const artifacts = new ArtifactStore(args.project);
    const projectConfig = await artifacts.readYaml('config.yaml', ProjectConfigSchema);
    sig.throwIfAborted();
    if (!projectConfig) {
      await artifacts.writeYaml('config.yaml', CONFIG_TEMPLATE);
      log('已写入 .crosscheck/config.yaml 默认配置（可按需修改），继续扫描项目');
      sig.throwIfAborted();
    }
    const notesCode = await generateNotes(args, log, deps, sig, artifacts);
    if (notesCode !== 0) return notesCode;
    sig.throwIfAborted();
    // 笔记此时已确认（刚自动确认，或此前已确认），直接复用画像生成。
    const profileCode = await profileCommand(args, log, deps, sig);
    if (profileCode !== 0) return profileCode;
    sig.throwIfAborted();
    await autoApproveVerified(args, log, deps, sig, artifacts);
    sig.throwIfAborted();
    return handOffReview(args, log, deps, sig, artifacts);
  });
}

/** 生成笔记并自动确认；已确认且未 --refresh 时跳过。返回 0 表示可继续。 */
async function generateNotes(args: CliArgs, log: Logger, deps: CommandDependencies, sig: AbortSignal, artifacts: ArtifactStore): Promise<number> {
  const approvals = await Approvals.load(artifacts);
  const original = await artifacts.readBytes(NOTES_FILE);
  let existing: string | undefined;
  try { existing = original === undefined ? undefined : decodeNotesUtf8(original); }
  catch { log('notes.md 不是有效的 UTF-8，请修复后重试'); return 2; }
  sig.throwIfAborted();
  if (existing !== undefined && approvals.state('notes', 'project', existing) === 'approved' && !args.refresh) {
    log('项目笔记已确认，跳过笔记生成（需要更新时使用 --refresh）');
    return 0;
  }
  // —— 以下与原实现一致，仅 return 0 改为写入后自动确认 ——
  if (args.refresh && existing !== undefined && !NotesTextSchema.safeParse(existing).success) {
    log('旧笔记格式不合法或超过大小限制，请修复后刷新'); return 2;
  }
  const context = await loadModelContext(artifacts, deps);
  const { config, redactor } = context;
  const walk = await walkProject(args.project, { signal: sig });
  for (const diagnostic of walk.diagnostics) log(redactor.text(`扫描诊断：${diagnostic}`));
  log(`登记文件 ${walk.files.length} 个，由模型按需读取`);
  sig.throwIfAborted();
  const models = resolveModels(config, 'extractor', context.deps, (line) => log(redactor.text(line)));
  const result = await withCliProgress((line) => log(redactor.text(line)), () => synthesizeNotes({
    projectRoot: args.project, files: walk.files, diagnostics: walk.diagnostics.map((line) => redactor.text(line)),
    previous: args.refresh && existing !== undefined ? redactor.text(existing) : undefined,
    clean: (text) => redactor.text(text),
    models, budget: () => new BudgetTracker(config.budget.discovery), signal: sig, resilience: deps.resilience,
  })).catch((error: unknown) => {
    if (sig.aborted && (error === sig.reason || error instanceof Error && error.name === 'AbortError')) throw error;
    throw new Error(redactor.text(error instanceof Error ? error.message : '模型调用失败'));
  });
  sig.throwIfAborted();
  if (result.status !== 'done') {
    log(redactor.text(`笔记生成失败：${result.detail}`));
    if (result.reason === 'budget') log('可在 .crosscheck/config.yaml 的 budget.discovery 中调大扫描预算');
    return 2;
  }
  const text = redactor.text(sanitizeMultiline(result.text));
  if (!NotesTextSchema.safeParse(text).success) { log('脱敏后的笔记格式不合法，未写入'); return 2; }
  const current = await artifacts.readBytes(NOTES_FILE);
  sig.throwIfAborted();
  if (original === undefined ? current !== undefined : current === undefined || !original.equals(current)) {
    log('项目笔记在生成期间发生修改，未覆盖；请重试'); return 2;
  }
  const latestApprovals = await Approvals.load(artifacts);
  if (JSON.stringify(latestApprovals.record('notes', 'project')) !== JSON.stringify(approvals.record('notes', 'project'))) {
    log('笔记审核记录在生成期间发生变化，未覆盖；请重试'); return 2;
  }
  sig.throwIfAborted();
  await artifacts.writeBytes(NOTES_FILE, Buffer.from(text));
  sig.throwIfAborted();
  const confirmed = await Approvals.load(artifacts);
  confirmed.approve('notes', 'project', text, AUTO_REVIEWER);
  await confirmed.save(artifacts);
  log('项目笔记已写入 .crosscheck/notes.md 并自动确认（确认人 auto）');
  return 0;
}

/** 对 api-catalog/pages 逐条核验来源：剔除无证据条目，剩余内容整份自动确认；全部未通过则留给人。 */
async function autoApproveVerified(args: CliArgs, log: Logger, deps: CommandDependencies, sig: AbortSignal, artifacts: ArtifactStore): Promise<void> {
  const { redactor } = await loadModelContext(artifacts, deps);
  const walk = await walkProject(args.project, { signal: sig });
  for (const { name, key } of VERIFIABLE) {
    const path = `system/${name}`;
    const snapshot = await artifacts.readBytes(path);
    const file = await readProfileFile(artifacts, name);
    if (!snapshot || !file.present || !file.ok) continue;
    if ((await Approvals.load(artifacts)).state('profile', name, file.value) === 'approved') continue;
    // 画像值的 operations/pages 都是 { [名称]: { sources: [...] } } 结构。
    const value = file.value as Record<string, unknown> & Record<typeof key, Record<string, { sources: { file: string; line: number; excerpt: string }[] }>>;
    const { kept, dropped } = await verifyEntrySources({ projectRoot: args.project, files: walk.files, entries: value[key], clean: (text) => redactor.text(text), signal: sig });
    for (const item of dropped) log(redactor.text(`核验未通过，已从 ${name} 剔除 ${item.name}（${item.reason}）`));
    if (Object.keys(kept).length === 0) { log(`${name} 没有通过来源核验的条目，交由人工审核`); continue; }
    sig.throwIfAborted();
    let approved: unknown = file.value;
    if (dropped.length) {
      const now = await artifacts.readBytes(path);
      if (!now || !now.equals(snapshot)) { log(`${name} 在核验期间被修改，跳过自动确认`); continue; }
      await artifacts.writeYaml(path, { ...value, [key]: kept });
      const reread = await readProfileFile(artifacts, name);
      if (!reread.present || !reread.ok) { log(`${name} 剔除后格式不合法，交由人工审核`); continue; }
      approved = reread.value;
    }
    const latest = await Approvals.load(artifacts);
    latest.approve('profile', name, approved, AUTO_REVIEWER);
    await latest.save(artifacts);
    log(`${name} 已自动确认（确认人 auto），保留 ${Object.keys(kept).length} 条${dropped.length ? `，剔除 ${dropped.length} 条` : ''}`);
  }
}

async function pendingProfiles(artifacts: ArtifactStore): Promise<ProfileFile[]> {
  const approvals = await Approvals.load(artifacts);
  const pending: ProfileFile[] = [];
  for (const file of await readProfileFiles(artifacts)) {
    if (!file.present || !file.ok || approvals.state('profile', file.name, file.value) !== 'approved') pending.push(file.name);
  }
  return PROFILE_FILES.filter((name) => pending.includes(name));
}

/** 待人工确认的画像：会话内交给会话；TTY 下直接进入审核；非 TTY 打印清单并退出 2。 */
async function handOffReview(args: CliArgs, log: Logger, deps: CommandDependencies, sig: AbortSignal, artifacts: ArtifactStore): Promise<number> {
  const pending = await pendingProfiles(artifacts);
  if (pending.length === 0) { log('笔记与七份画像均已确认'); return 0; }
  log(`以下画像需要人工确认：${pending.join('、')}`);
  if (deps.init?.deferReview) { deps.init.deferReview(pending); return 0; }
  if (!(deps.review?.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    log('当前不是交互式终端，请在交互式终端运行 crosscheck review profile 完成确认');
    return 2;
  }
  const code = await reviewCommand({ ...args, command: 'review', view: 'profile', only: pending }, log, deps, sig);
  const left = await pendingProfiles(artifacts);
  if (left.length) log(`仍有 ${left.length} 份画像未确认：${left.join('、')}；可运行 crosscheck review profile 继续`);
  return code;
}
```

`packages/cli/src/session.ts`：
- 顶部补 `import type { ProfileFile } from '@crosscheck/core';`（若已有 core 导入则合并），确认 `parseArgs` 已导入（第 92 行已在用）。
- 在 `if (tokens[0] === 'review') {` 之前加入：

```ts
    if (tokens[0] === 'init') {
      let pending: ProfileFile[] = [];
      const lines: string[] = [];
      const code = await cliMain(tokens, {
        dependencies: { ...deps, init: { deferReview: (only) => { pending = only; } } },
        signal,
        log: (line) => { lines.push(line); onProgress?.(line); },
      });
      if (code === 0 && pending.length) {
        const project = parseArgs(tokens).project;
        return { kind: 'review', args: { project, view: 'profile', only: pending }, lines };
      }
      return { kind: 'log', code, lines };
    }
```
- `sessionSlashCommands` 里 init 的描述改为 `'扫描项目，自动确认笔记并生成画像，仅把需人工确认的画像交给审核'`；profile 的描述改为 `'单独重新生成画像草稿（需已确认笔记）'`。

- [ ] **Step 4: 修正受影响的既有用例并运行**

`init` 现在会继续生成画像，既有 `packages/cli/test/init.test.ts` 里"只提供笔记一步脚本"的用例会因模型脚本耗尽而失败，且"不创建确认记录/保留原确认记录"的断言不再成立。处理方式：

1. 在 `init.test.ts` 顶部加辅助：

```ts
const PROFILE_STEPS: ScriptStep[] = [
  { toolCalls: [{ name: 'finish', input: { findings: [] } }] },
  { toolCalls: [{ name: 'finish', input: { 'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:3000', healthcheck: 'http://localhost:3000/health', reset: null } } } } }] },
  { toolCalls: [{ name: 'finish', input: { 'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } } } }] },
  { toolCalls: [{ name: 'finish', input: { 'api-catalog.yaml': { version: 1, operations: {} }, 'pages.yaml': { version: 1, pages: {} } } }] },
  { toolCalls: [{ name: 'finish', input: { 'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: {} } } }] },
  { toolCalls: [{ name: 'finish', input: { 'guardrails.yaml': { allowedHosts: ['localhost:3000'] } } }] },
];
const nonTty = { review: { isTTY: false } };
```
2. 所有"成功生成笔记"的用例（`没有 config.yaml 时…`、`生成笔记草稿…`、`刷新已确认笔记时…`、`模型笔记里的未知密码…`、`模型按需读取项目文件…` 等）：把 `scriptedModel([笔记步骤])` 改为 `scriptedModel([笔记步骤, ...PROFILE_STEPS])`，`deps(model)` 里追加 `...nonTty`（不要让测试进入真实审核），并把期望退出码从 `0` 改为 `2`（五份画像仍待人工确认，非 TTY 退出 2）。
3. 断言更新：
   - `生成笔记草稿且不创建确认记录` → 改名为 `生成笔记并自动确认`，断言 `(await Approvals.load(artifacts)).record('notes','project')?.by` 为 `'auto'`。
   - `刷新已确认笔记时脱敏旧内容并保留原确认记录` → 改名为 `刷新已确认笔记时脱敏旧内容并以 auto 重新确认`，把 `state(...)` 期望从 `'stale'` 改为 `'approved'`，删除 `approvals.json` 与 `before` 相等的断言，改为断言 `by` 为 `'auto'`。
   - 失败路径用例（取消、非法 UTF-8、笔记被修改、被确认、格式不合法、预算耗尽、宿主异常）保持不变，它们都在笔记步骤就返回，不会进入画像。

Run: `pnpm vitest run packages/cli packages/discovery packages/tui packages/core`
Expected: PASS；若有用例因同样原因失败，按上面第 2 条处理，不要放宽断言。

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/cli
git commit -m "feat(init): 一条命令完成笔记与画像，自动确认可核验内容并交接审核"
```

---

### Task 5: 文档与全量验证

**Files:**
- Modify: `README.md`
- Modify: `docs/manual-integration.md`
- Modify: `docs/superpowers/specs/2026-11-23-init-all-in-one-design.md`（状态改为已实现，并同步"与 spec 的差异"）

- [ ] **Step 1: 更新 README**

1. 流程句（"可使用 `init → review notes → profile → review profile → reqs → ...`"）改为：`可使用 init → reqs → plan → review cases → run 流程（init 内部完成笔记、画像生成与可核验内容的自动确认，并在同一命令里交给人确认其余画像；plan 前还需 review clauses 确认条款）`。
2. 命令表 `init` 行改为：`init [--refresh] [--openapi <文件>]...` | `缺少配置时先写入默认 config.yaml；扫描项目生成笔记并自动确认（确认人 auto）；生成七份画像；对 api-catalog 与 pages 逐条核验来源，剔除无证据条目后整份自动确认；其余画像（environments、auth、data-model、fixtures、guardrails 及未通过核验的文件）在 TTY 下直接进入审核，非 TTY 打印清单并退出 2；已确认内容默认跳过，--refresh 强制刷新`。
3. `profile` 行说明改为 `单独重跑画像（需笔记已确认），可追加 --openapi；init 已包含此步骤`。
4. "迁移与审核门禁"段末尾追加一段风险说明：`init 自动确认笔记，不再保证有人看过笔记；笔记只影响画像生成和需求文档范围（仅在 config.yaml 的 requirementsDocs 为空时生效，路径经安全校验），不直接决定测什么。画像中 environments、auth、data-model、fixtures、guardrails 始终由人确认，条款与用例的确认门禁不变。review 画像列表会显示确认人，auto 表示由宿主核验后自动确认。`

- [ ] **Step 2: 更新 `docs/manual-integration.md`**

搜索 `init`、`review notes`、`profile` 的流程描述（`grep -n "review notes\|crosscheck profile\|init" docs/manual-integration.md`），把"先 init、再 review notes、再 profile、再 review profile"的步骤合并为"运行 init；有待确认画像时在审核界面确认"，保留手工准备七画像的独立说明不变。

- [ ] **Step 3: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全部通过。任何失败先定位原因，不要跳过。

- [ ] **Step 4: 手工冒烟（可选，需要真实模型配置时）**

在一个小的测试项目里运行 `pnpm crosscheck init --project <目录>`，确认：笔记与 `api-catalog`/`pages` 自动确认、审核界面只列待确认画像且列表显示确认人。未配置真实模型则跳过，并在汇报中明确说明未做此项。

- [ ] **Step 5: 更新 spec 状态并提交**

把 spec 顶部 `状态：待审阅` 改为 `状态：已实现（2026-11-24）`，并把"与 spec 的差异"三条同步到 spec 末尾。

```bash
git add README.md docs
git commit -m "docs: init 一条命令完成笔记与画像的流程说明"
```

---

## Self-Review

- **Spec 覆盖**：流程（Task 4）、自动确认范围与剔除汇总（Task 1、4）、确认记录与 `auto`（Task 2、4）、TTY/非 TTY/会话交接（Task 3、4）、`--openapi`（Task 2）、`profile` 保留（Task 4 直接复用）、门禁不变（Task 4 最后一个用例）、风险写入 README（Task 5）、测试清单逐项对应 Task 1/3/4。`--refresh`：Task 4 用例"已确认重跑跳过"覆盖跳过；刷新路径由改写后的既有用例覆盖。
- **占位符**：无 TBD；Task 4 Step 4 对既有用例的改法给出了具体规则、辅助代码与断言替换；最后一个新用例的条款读取方法需按实际 `ArtifactStore` 方法名确认，已在其下给出确认命令。
- **类型一致**：`AUTO_REVIEWER`、`only: ProfileFile[]`、`deferReview(only)`、`verifyEntrySources` 的签名在各任务间一致；`initialRoute` 第四个参数 `only` 与 `RunReviewOptions.only`、`SlashCommandResult.review.args.only` 一致。
