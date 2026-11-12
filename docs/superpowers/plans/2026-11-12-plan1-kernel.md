# 计划 1：内核（core / models / agent）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 pnpm monorepo，实现 Crosscheck 内核：工件 schema 与存储、哈希确认、工作流门禁、证据守卫与合议、URL/SQL 守卫、脱敏、预算、按角色解析模型（重试 + 备用模型 + 用量统计）、带工具授予与强制结构化输出的代理循环，以及确定性的假模型。

**Architecture:** 三个包，依赖方向 `agent → models → core`，`core` 无内部依赖。所有包直接以 TS 源码作为入口（`exports` 指向 `src/index.ts`），vitest 直接跑源码，`tsc --noEmit` 做全仓类型检查；发布构建留到后续计划。代理循环自研：每轮调用一次 `generateText`（工具不带 `execute`），由我们自己执行工具、校验输入输出、记账预算；最终结果通过内置的 `finish` 工具提交并用 zod 校验。

**Tech Stack:** TypeScript（Node ≥ 20，ESM）、pnpm 9 workspace、zod 4、yaml、vitest、Vercel AI SDK v7（`ai`、`ai/test` 的 `MockLanguageModelV4`、`@ai-sdk/*`）。

**Spec:** `docs/specs/2026-11-12-v1-design.md`

## 计划路线图（本文件只覆盖计划 1）

| 计划 | 内容 | 依赖 |
|---|---|---|
| **1 内核（本文件）** | monorepo、core、models、agent、假模型 | — |
| 2 执行管线 | tools（browser/http/db/fixture/profile + 证据采集与轨迹）、单用例流程（预检→准备→执行→自判→盲审→合议）、上下文压缩、断点续跑、中断处理、report（results.json / junit.xml / HTML）、`crosscheck run` / `report` | 1 |
| 3 发现与审核 | discovery（静态扫描、OpenAPI 插件、插件接口、`record`）、`init` / `reqs` / `plan`、Ink TUI（画像 / 条款 / 用例 / 结果四类审核） | 1、2 |
| 4 靶场与试点 | `examples/shop-demo`、植入 bug 清单、召回率/误报率评测脚本、多厂商验证、社区治理 M09 接入 | 1～3 |

## Global Constraints

- Node.js ≥ 20，ESM（所有 `package.json` 含 `"type": "module"`）。
- pnpm monorepo，包位于 `packages/*`，包名 `@crosscheck/<name>`。
- 配置、工件、模型输出共用 zod schema（zod 4，`import { z } from 'zod'`）。
- 测试用 vitest；测试不得访问网络、不得消耗真实 token。
- 代码注释、错误信息、文档使用中文；标识符用英文。
- 密钥只从环境变量读取，配置中只写变量名。
- Crosscheck 只写被测项目的 `.crosscheck/` 目录，不写其他位置。
- 判定状态严重程度：`BLOCKED` > `FAIL` > `DISPUTED` > `UNCLEAR` > `PASS`。
- 退出码：`0` 全部通过；`1` 有 `FAIL`；`2` 有 `DISPUTED`、`UNCLEAR` 或 `BLOCKED`；`3` 工具自身出错。
- 结构化输出不合格时把错误反馈给模型重试，累计 3 次不合格判为 `BLOCKED`。
- 每个用例预算默认：步数 60、token 400000、时长 10 分钟。
- 执行阶段不授予夹具工具；数据库只允许只读。

## 文件结构

```
package.json                     根：脚本、devDependencies
pnpm-workspace.yaml
tsconfig.base.json / tsconfig.json
vitest.config.ts
packages/core/
  package.json
  src/index.ts                   统一导出
  src/schema/artifacts.ts        条款、用例、预期、证据类型
  src/schema/config.ts           config.yaml
  src/schema/guardrails.ts       guardrails.yaml
  src/schema/verdict.ts          判定、状态、证据记录
  src/store/artifact-store.ts    .crosscheck/ 读写（YAML/JSON、原子写、路径约束）
  src/approvals/hash.ts          规范化 + 内容哈希
  src/approvals/approvals.ts     approvals.json
  src/workflow/gate.ts           阶段门禁
  src/verdict/evidence-guard.ts  判定的证据校验
  src/verdict/consensus.ts       合议、用例汇总、退出码
  src/guard/url-guard.ts         白名单与禁止规则
  src/guard/sql-guard.ts         只读 SQL 校验
  src/redact/redact.ts           脱敏
  src/budget/budget.ts           步数/token/时长预算
  test/*.test.ts
packages/models/
  src/model-ref.ts  src/providers.ts  src/resolve.ts  src/resilience.ts  src/usage.ts  src/index.ts
  test/*.test.ts
packages/agent/
  src/tool.ts  src/grants.ts  src/loop.ts  src/testing/scripted-model.ts  src/index.ts
  test/*.test.ts
```

---

### Task 1: monorepo 脚手架 + core schema

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/core/package.json`, `packages/core/src/index.ts`
- Create: `packages/core/src/schema/artifacts.ts`, `config.ts`, `guardrails.ts`, `verdict.ts`
- Test: `packages/core/test/schema.test.ts`

**Interfaces:**
- Produces（后续任务全部依赖这些名字）:
  - `EvidenceTypeSchema`（`'screenshot'|'dom'|'network'|'console'|'db'`）、`type EvidenceType`
  - `ClauseSchema`、`type Clause = { id; text; source: { file; line; excerpt }; status: 'active'|'unclear'|'removed'; notes }`
  - `ExpectationSchema`、`type Expectation = { id; text; evidence: EvidenceType[] }`
  - `TestCaseSchema`、`type TestCase = { id; covers: string[]; fixtures: string[]; actor; steps: string[]; expectations: Expectation[] }`
  - `ModuleClausesSchema`、`ModuleCasesSchema`（数组 + id 唯一）
  - `ROLES = ['extractor','planner','executor','reviewer'] as const`、`type Role`
  - `PROVIDER_TYPES`、`type ProviderType`、`ModelRefSchema`、`ConfigSchema`、`type Config`、`type BudgetLimits = { steps; tokens; minutes }`
  - `GuardrailsSchema`、`type Guardrails = { allowedHosts: string[]; forbidden: { method?: string; path: string }[]; redactFields: string[] }`
  - `JudgementSchema`、`type Judgement = { expectationId; verdict: 'pass'|'fail'|'unclear'; evidenceIds: string[]; reasoning }`
  - `EXPECTATION_STATUSES`、`type ExpectationStatus = 'PASS'|'FAIL'|'DISPUTED'|'UNCLEAR'|'BLOCKED'`
  - `EvidenceRecordSchema`、`type EvidenceRecord = { id; type: EvidenceType; path?: string; summary?: string }`

- [ ] **Step 1: 写根配置文件**

`package.json`:

```json
{
  "name": "crosscheck-monorepo",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.9",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - examples/*
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "include": ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "vitest.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['packages/*/test/**/*.test.ts'] },
});
```

`packages/core/package.json`:

```json
{
  "name": "@crosscheck/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

- [ ] **Step 2: 安装依赖**

Run:
```bash
pnpm add -Dw typescript vitest @types/node
pnpm --filter @crosscheck/core add zod yaml
```
Expected: 成功生成 `pnpm-lock.yaml`，`packages/core/package.json` 出现 `zod`（4.x）与 `yaml`。若 zod 装到 3.x，改为 `pnpm --filter @crosscheck/core add zod@^4`。

- [ ] **Step 3: 写失败的 schema 测试**

`packages/core/test/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ClauseSchema,
  ConfigSchema,
  GuardrailsSchema,
  JudgementSchema,
  ModuleCasesSchema,
  ModuleClausesSchema,
  TestCaseSchema,
} from '../src/index';

const clause = {
  id: 'M09-AC-003',
  text: '“为什么是 X 票？”正确列出成员身份',
  source: { file: 'doc/M09.md', line: 439, excerpt: '原文' },
};

const testCase = {
  id: 'M09-TC-007',
  covers: ['M09-AC-003'],
  fixtures: ['reset'],
  actor: 'member',
  steps: ['打开投票中提案详情页'],
  expectations: [{ id: 'E1', text: '列出成员身份', evidence: ['screenshot', 'dom'] }],
};

describe('ClauseSchema', () => {
  it('补全默认的 status 与 notes', () => {
    const c = ClauseSchema.parse(clause);
    expect(c.status).toBe('active');
    expect(c.notes).toBe('');
  });

  it('拒绝不合规的 id', () => {
    expect(ClauseSchema.safeParse({ ...clause, id: 'AC3' }).success).toBe(false);
  });

  it('模块内 id 重复时报错', () => {
    expect(ModuleClausesSchema.safeParse([clause, clause]).success).toBe(false);
  });
});

describe('TestCaseSchema', () => {
  it('解析合法用例', () => {
    expect(TestCaseSchema.parse(testCase).expectations[0]?.evidence).toEqual(['screenshot', 'dom']);
  });

  it('预期必须声明至少一种证据类型', () => {
    const bad = { ...testCase, expectations: [{ id: 'E1', text: 'x', evidence: [] }] };
    expect(TestCaseSchema.safeParse(bad).success).toBe(false);
  });

  it('未知证据类型被拒绝', () => {
    const bad = { ...testCase, expectations: [{ id: 'E1', text: 'x', evidence: ['video'] }] };
    expect(TestCaseSchema.safeParse(bad).success).toBe(false);
  });

  it('模块内用例 id 重复时报错', () => {
    expect(ModuleCasesSchema.safeParse([testCase, testCase]).success).toBe(false);
  });
});

describe('ConfigSchema', () => {
  const models = {
    extractor: 'anthropic:claude-sonnet-4-6',
    planner: 'deepseek:deepseek-chat',
    executor: 'openai:gpt-5.4',
    reviewer: 'qwen:qwen-max',
  };

  it('补全预算默认值', () => {
    const cfg = ConfigSchema.parse({ models });
    expect(cfg.budget.perCase).toEqual({ steps: 60, tokens: 400000, minutes: 10 });
    expect(cfg.models.fallback).toEqual({});
    expect(cfg.providers).toEqual({});
  });

  it('模型引用必须是 provider:model 形式', () => {
    expect(ConfigSchema.safeParse({ models: { ...models, executor: 'gpt-5.4' } }).success).toBe(false);
  });

  it('自定义 provider 只写环境变量名', () => {
    const cfg = ConfigSchema.parse({
      models,
      providers: {
        qwen: {
          type: 'openai-compatible',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKeyEnv: 'DASHSCOPE_API_KEY',
        },
      },
    });
    expect(cfg.providers.qwen?.apiKeyEnv).toBe('DASHSCOPE_API_KEY');
  });
});

describe('GuardrailsSchema', () => {
  it('白名单不能为空', () => {
    expect(GuardrailsSchema.safeParse({ allowedHosts: [] }).success).toBe(false);
  });

  it('补全默认值', () => {
    const g = GuardrailsSchema.parse({ allowedHosts: ['localhost:3000'] });
    expect(g.forbidden).toEqual([]);
    expect(g.redactFields).toEqual([]);
  });
});

describe('JudgementSchema', () => {
  it('verdict 只能是 pass/fail/unclear', () => {
    const j = { expectationId: 'E1', verdict: 'ok', evidenceIds: [], reasoning: 'x' };
    expect(JudgementSchema.safeParse(j).success).toBe(false);
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm vitest run packages/core/test/schema.test.ts`
Expected: FAIL，提示无法解析 `../src/index`。

- [ ] **Step 5: 实现 schema**

`packages/core/src/schema/artifacts.ts`:

```ts
import { z } from 'zod';

/** 判定可以引用的证据类型 */
export const EVIDENCE_TYPES = ['screenshot', 'dom', 'network', 'console', 'db'] as const;
export const EvidenceTypeSchema = z.enum(EVIDENCE_TYPES);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const ClauseIdSchema = z.string().regex(/^[A-Za-z0-9_]+-AC-\d+$/, '条款 id 形如 M09-AC-003');
export const CaseIdSchema = z.string().regex(/^[A-Za-z0-9_]+-TC-\d+$/, '用例 id 形如 M09-TC-007');

export const SourceRefSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  excerpt: z.string(),
});

export const ClauseSchema = z.object({
  id: ClauseIdSchema,
  text: z.string().min(1),
  source: SourceRefSchema,
  status: z.enum(['active', 'unclear', 'removed']).default('active'),
  notes: z.string().default(''),
});
export type Clause = z.infer<typeof ClauseSchema>;

export const ExpectationSchema = z.object({
  id: z.string().regex(/^E\d+$/, '预期 id 形如 E1'),
  text: z.string().min(1),
  evidence: z.array(EvidenceTypeSchema).min(1, '至少声明一种证据类型'),
});
export type Expectation = z.infer<typeof ExpectationSchema>;

/** 数组内 id 唯一性校验 */
function uniqueIds<T extends { id: string }>(items: T[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) ctx.addIssue({ code: 'custom', message: `id 重复：${item.id}` });
    seen.add(item.id);
  }
}

export const TestCaseSchema = z.object({
  id: CaseIdSchema,
  covers: z.array(ClauseIdSchema).min(1),
  fixtures: z.array(z.string().min(1)).default([]),
  actor: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  expectations: z.array(ExpectationSchema).min(1).superRefine(uniqueIds),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const ModuleClausesSchema = z.array(ClauseSchema).superRefine(uniqueIds);
export const ModuleCasesSchema = z.array(TestCaseSchema).superRefine(uniqueIds);
```

`packages/core/src/schema/config.ts`:

```ts
import { z } from 'zod';

export const ROLES = ['extractor', 'planner', 'executor', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export const PROVIDER_TYPES = ['anthropic', 'openai', 'google', 'deepseek', 'ollama', 'openai-compatible'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** provider:model，model 部分允许再含冒号（如 ollama:qwen2.5:7b） */
export const ModelRefSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*:.+$/, '模型写成 provider:model 形式');

const ProviderConfigSchema = z.object({
  type: z.enum(PROVIDER_TYPES),
  baseURL: z.string().url().optional(),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, '这里只写环境变量名').optional(),
});

const BudgetLimitsSchema = z.object({
  steps: z.number().int().positive().default(60),
  tokens: z.number().int().positive().default(400000),
  minutes: z.number().positive().default(10),
});
export type BudgetLimits = z.infer<typeof BudgetLimitsSchema>;

export const ConfigSchema = z.object({
  models: z.object({
    extractor: ModelRefSchema,
    planner: ModelRefSchema,
    executor: ModelRefSchema,
    reviewer: ModelRefSchema,
    fallback: z
      .object({
        extractor: ModelRefSchema.optional(),
        planner: ModelRefSchema.optional(),
        executor: ModelRefSchema.optional(),
        reviewer: ModelRefSchema.optional(),
      })
      .prefault({}),
  }),
  providers: z.record(z.string(), ProviderConfigSchema).prefault({}),
  budget: z.object({ perCase: BudgetLimitsSchema.prefault({}) }).prefault({}),
  /** 每百万 token 单价，键为模型引用 */
  pricing: z
    .record(ModelRefSchema, z.object({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() }))
    .prefault({}),
  requirementsDocs: z.array(z.string()).prefault([]),
  defaultEnvironment: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;
```

`packages/core/src/schema/guardrails.ts`:

```ts
import { z } from 'zod';

export const GuardrailsSchema = z.object({
  /** 允许访问的主机：`host`、`host:port` 或 `*.example.com` */
  allowedHosts: z.array(z.string().min(1)).min(1, '必须至少登记一个允许的主机'),
  /** 禁止的请求：method 省略表示任意方法；path 支持 * 与 ** 通配 */
  forbidden: z
    .array(z.object({ method: z.string().optional(), path: z.string().min(1) }))
    .default([]),
  /** 需要额外脱敏的字段名（不区分大小写） */
  redactFields: z.array(z.string().min(1)).default([]),
});
export type Guardrails = z.infer<typeof GuardrailsSchema>;
```

`packages/core/src/schema/verdict.ts`:

```ts
import { z } from 'zod';
import { EvidenceTypeSchema } from './artifacts';

export const JudgementSchema = z.object({
  expectationId: z.string().min(1),
  verdict: z.enum(['pass', 'fail', 'unclear']),
  evidenceIds: z.array(z.string()),
  reasoning: z.string(),
});
export type Judgement = z.infer<typeof JudgementSchema>;

export const EXPECTATION_STATUSES = ['PASS', 'FAIL', 'DISPUTED', 'UNCLEAR', 'BLOCKED'] as const;
export type ExpectationStatus = (typeof EXPECTATION_STATUSES)[number];

export const EvidenceRecordSchema = z.object({
  id: z.string().min(1),
  type: EvidenceTypeSchema,
  path: z.string().optional(),
  summary: z.string().optional(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
```

`packages/core/src/index.ts`:

```ts
export * from './schema/artifacts';
export * from './schema/config';
export * from './schema/guardrails';
export * from './schema/verdict';
```

- [ ] **Step 6: 运行测试与类型检查**

Run: `pnpm vitest run packages/core/test/schema.test.ts && pnpm typecheck`
Expected: 全部 PASS，tsc 无输出。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): monorepo 脚手架与工件 schema"
```

---

### Task 2: 工件存储 ArtifactStore

**Files:**
- Create: `packages/core/src/store/artifact-store.ts`
- Modify: `packages/core/src/index.ts`（追加导出）
- Test: `packages/core/test/artifact-store.test.ts`

**Interfaces:**
- Consumes: `ModuleClausesSchema`、`ModuleCasesSchema`、`ConfigSchema`、`Clause`、`TestCase`、`Config`（Task 1）
- Produces:
  - `class ArtifactStore { constructor(projectRoot: string); readonly root: string; resolve(rel: string): string; readYaml<T>(rel, schema: z.ZodType<T>): Promise<T | undefined>; writeYaml(rel, data: unknown): Promise<void>; readJson<T>(rel, schema): Promise<T | undefined>; writeJson(rel, data): Promise<void>; loadClauses(module): Promise<Clause[]>; saveClauses(module, clauses): Promise<void>; loadCases(module): Promise<TestCase[]>; saveCases(module, cases): Promise<void>; listModules(kind: 'requirements' | 'cases'): Promise<string[]>; loadConfig(): Promise<Config> }`
  - `class ArtifactError extends Error`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/artifact-store.test.ts`:

```ts
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactError, ArtifactStore, type Clause } from '../src/index';

let dir: string;
let store: ArtifactStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cc-store-'));
  store = new ArtifactStore(dir);
});

const clause: Clause = {
  id: 'M09-AC-001',
  text: '条款',
  source: { file: 'a.md', line: 1, excerpt: '原文' },
  status: 'active',
  notes: '',
};

describe('ArtifactStore', () => {
  it('根目录是 .crosscheck', () => {
    expect(store.root).toBe(path.join(dir, '.crosscheck'));
  });

  it('条款可往返读写，文件为 YAML', async () => {
    await store.saveClauses('M09', [clause]);
    expect(await store.loadClauses('M09')).toEqual([clause]);
    const raw = await readFile(path.join(dir, '.crosscheck/requirements/M09.yaml'), 'utf8');
    expect(raw).toContain('id: M09-AC-001');
  });

  it('不存在的模块返回空数组', async () => {
    expect(await store.loadCases('NOPE')).toEqual([]);
  });

  it('拒绝逃逸出 .crosscheck 的路径', () => {
    expect(() => store.resolve('../src/app.ts')).toThrow(ArtifactError);
  });

  it('拒绝非法模块名', async () => {
    await expect(store.saveClauses('../x', [clause])).rejects.toThrow(ArtifactError);
  });

  it('内容不合 schema 时报错并带文件路径', async () => {
    await mkdir(path.join(dir, '.crosscheck/requirements'), { recursive: true });
    await writeFile(path.join(dir, '.crosscheck/requirements/M01.yaml'), '- id: bad\n', 'utf8');
    await expect(store.loadClauses('M01')).rejects.toThrow(/requirements[\\/]M01\.yaml/);
  });

  it('列出模块', async () => {
    await store.saveClauses('M09', [clause]);
    await store.saveClauses('M01', []);
    expect(await store.listModules('requirements')).toEqual(['M01', 'M09']);
    expect(await store.listModules('cases')).toEqual([]);
  });

  it('缺少 config.yaml 时给出可读的错误', async () => {
    await expect(store.loadConfig()).rejects.toThrow(/crosscheck init/);
  });

  it('JSON 往返读写', async () => {
    const schema = (await import('zod')).z.object({ a: (await import('zod')).z.number() });
    await store.writeJson('x/y.json', { a: 1 });
    expect(await store.readJson('x/y.json', schema)).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/core/test/artifact-store.test.ts`
Expected: FAIL，`ArtifactStore` 未导出。

- [ ] **Step 3: 实现**

`packages/core/src/store/artifact-store.ts`:

```ts
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { z } from 'zod';
import { ModuleCasesSchema, ModuleClausesSchema, type Clause, type TestCase } from '../schema/artifacts';
import { ConfigSchema, type Config } from '../schema/config';

export class ArtifactError extends Error {
  override name = 'ArtifactError';
}

const MODULE_NAME = /^[A-Za-z0-9_-]+$/;

function assertModule(module: string): void {
  if (!MODULE_NAME.test(module)) throw new ArtifactError(`非法的模块名：${module}`);
}

/** 读写被测项目中的 .crosscheck/ 目录；所有写入都被限制在该目录内 */
export class ArtifactStore {
  readonly root: string;

  constructor(projectRoot: string) {
    this.root = path.resolve(projectRoot, '.crosscheck');
  }

  /** 解析相对路径，结果必须位于 .crosscheck/ 内 */
  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    const relative = path.relative(this.root, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ArtifactError(`路径超出 .crosscheck 目录：${rel}`);
    }
    return abs;
  }

  private async readText(rel: string): Promise<string | undefined> {
    try {
      return await readFile(this.resolve(rel), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /** 先写临时文件再改名，避免中断时留下半个文件 */
  private async writeText(rel: string, text: string): Promise<void> {
    const abs = this.resolve(rel);
    await mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, abs);
  }

  private parse<T>(rel: string, data: unknown, schema: z.ZodType<T>): T {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ArtifactError(`${path.join('.crosscheck', rel)} 内容不合法：${result.error.message}`);
    }
    return result.data;
  }

  async readYaml<T>(rel: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const text = await this.readText(rel);
    if (text === undefined) return undefined;
    return this.parse(rel, YAML.parse(text) ?? null, schema);
  }

  async writeYaml(rel: string, data: unknown): Promise<void> {
    await this.writeText(rel, YAML.stringify(data, { lineWidth: 0 }));
  }

  async readJson<T>(rel: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const text = await this.readText(rel);
    if (text === undefined) return undefined;
    return this.parse(rel, JSON.parse(text), schema);
  }

  async writeJson(rel: string, data: unknown): Promise<void> {
    await this.writeText(rel, `${JSON.stringify(data, null, 2)}\n`);
  }

  async loadClauses(module: string): Promise<Clause[]> {
    assertModule(module);
    return (await this.readYaml(`requirements/${module}.yaml`, ModuleClausesSchema)) ?? [];
  }

  async saveClauses(module: string, clauses: Clause[]): Promise<void> {
    assertModule(module);
    await this.writeYaml(`requirements/${module}.yaml`, ModuleClausesSchema.parse(clauses));
  }

  async loadCases(module: string): Promise<TestCase[]> {
    assertModule(module);
    return (await this.readYaml(`cases/${module}.yaml`, ModuleCasesSchema)) ?? [];
  }

  async saveCases(module: string, cases: TestCase[]): Promise<void> {
    assertModule(module);
    await this.writeYaml(`cases/${module}.yaml`, ModuleCasesSchema.parse(cases));
  }

  async listModules(kind: 'requirements' | 'cases'): Promise<string[]> {
    try {
      const names = await readdir(this.resolve(kind));
      return names
        .filter((n) => n.endsWith('.yaml'))
        .map((n) => n.slice(0, -'.yaml'.length))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async loadConfig(): Promise<Config> {
    const cfg = await this.readYaml('config.yaml', ConfigSchema);
    if (!cfg) throw new ArtifactError('找不到 .crosscheck/config.yaml，请先运行 crosscheck init');
    return cfg;
  }
}
```

`packages/core/src/index.ts` 追加：

```ts
export * from './store/artifact-store';
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run packages/core/test/artifact-store.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): .crosscheck 工件存储"
```

---

### Task 3: 内容哈希与确认记录

**Files:**
- Create: `packages/core/src/approvals/hash.ts`, `packages/core/src/approvals/approvals.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/approvals.test.ts`

**Interfaces:**
- Consumes: `ArtifactStore.readJson/writeJson`（Task 2）
- Produces:
  - `canonicalize(value: unknown): string`、`contentHash(value: unknown): string`（`'sha256:<hex>'`）
  - `type ApprovalKind = 'clause' | 'case' | 'profile'`、`type ApprovalState = 'approved' | 'stale' | 'none'`
  - `class Approvals { static empty(): Approvals; static load(store): Promise<Approvals>; save(store): Promise<void>; approve(kind, id, content: unknown, by: string, at?: Date): void; revoke(kind, id): void; state(kind, id, content: unknown): ApprovalState; record(kind, id): { hash; by; at } | undefined }`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/approvals.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Approvals, ArtifactStore, canonicalize, contentHash } from '../src/index';

describe('contentHash', () => {
  it('与键顺序无关', () => {
    expect(contentHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(contentHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  it('忽略 undefined 字段', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('数组顺序有意义', () => {
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });

  it('格式为 sha256:hex', () => {
    expect(contentHash('x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('Approvals', () => {
  const entry = { id: 'M09-AC-001', text: '原文' };

  it('未确认为 none，确认后为 approved', () => {
    const a = Approvals.empty();
    expect(a.state('clause', entry.id, entry)).toBe('none');
    a.approve('clause', entry.id, entry, 'alice', new Date('2026-11-12T00:00:00Z'));
    expect(a.state('clause', entry.id, entry)).toBe('approved');
    expect(a.record('clause', entry.id)).toMatchObject({ by: 'alice', at: '2026-11-12T00:00:00.000Z' });
  });

  it('内容修改后确认自动失效', () => {
    const a = Approvals.empty();
    a.approve('clause', entry.id, entry, 'alice');
    expect(a.state('clause', entry.id, { ...entry, text: '改过' })).toBe('stale');
  });

  it('不同种类互不影响', () => {
    const a = Approvals.empty();
    a.approve('clause', 'X', entry, 'alice');
    expect(a.state('case', 'X', entry)).toBe('none');
  });

  it('撤销确认', () => {
    const a = Approvals.empty();
    a.approve('case', 'T', entry, 'alice');
    a.revoke('case', 'T');
    expect(a.state('case', 'T', entry)).toBe('none');
  });

  it('可持久化到 approvals.json', async () => {
    const store = new ArtifactStore(await mkdtemp(path.join(tmpdir(), 'cc-appr-')));
    const a = Approvals.empty();
    a.approve('profile', 'auth.yaml', { roles: [] }, 'bob');
    await a.save(store);
    const b = await Approvals.load(store);
    expect(b.state('profile', 'auth.yaml', { roles: [] })).toBe('approved');
  });

  it('文件不存在时加载为空', async () => {
    const store = new ArtifactStore(await mkdtemp(path.join(tmpdir(), 'cc-appr-')));
    expect((await Approvals.load(store)).state('clause', 'x', {})).toBe('none');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/core/test/approvals.test.ts`
Expected: FAIL，`Approvals` 未导出。

- [ ] **Step 3: 实现**

`packages/core/src/approvals/hash.ts`:

```ts
import { createHash } from 'node:crypto';

/** 规范化 JSON：对象键排序、去掉 undefined，保证同内容得到同字符串 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalize(v);
    }
    return out;
  }
  return value;
}

export function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}
```

`packages/core/src/approvals/approvals.ts`:

```ts
import { z } from 'zod';
import type { ArtifactStore } from '../store/artifact-store';
import { contentHash } from './hash';

export type ApprovalKind = 'clause' | 'case' | 'profile';
export type ApprovalState = 'approved' | 'stale' | 'none';

const ApprovalRecordSchema = z.object({ hash: z.string(), by: z.string(), at: z.string() });
type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

const ApprovalsFileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), ApprovalRecordSchema),
});

const FILE = 'approvals.json';

function key(kind: ApprovalKind, id: string): string {
  return `${kind}:${id}`;
}

/** 工件条目的确认记录：内容哈希不匹配即视为失效 */
export class Approvals {
  private constructor(private readonly entries: Map<string, ApprovalRecord>) {}

  static empty(): Approvals {
    return new Approvals(new Map());
  }

  static async load(store: ArtifactStore): Promise<Approvals> {
    const data = await store.readJson(FILE, ApprovalsFileSchema);
    return new Approvals(new Map(Object.entries(data?.entries ?? {})));
  }

  async save(store: ArtifactStore): Promise<void> {
    const sorted = Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
    await store.writeJson(FILE, { version: 1, entries: sorted });
  }

  approve(kind: ApprovalKind, id: string, content: unknown, by: string, at: Date = new Date()): void {
    this.entries.set(key(kind, id), { hash: contentHash(content), by, at: at.toISOString() });
  }

  revoke(kind: ApprovalKind, id: string): void {
    this.entries.delete(key(kind, id));
  }

  record(kind: ApprovalKind, id: string): ApprovalRecord | undefined {
    return this.entries.get(key(kind, id));
  }

  state(kind: ApprovalKind, id: string, content: unknown): ApprovalState {
    const rec = this.entries.get(key(kind, id));
    if (!rec) return 'none';
    return rec.hash === contentHash(content) ? 'approved' : 'stale';
  }
}
```

`packages/core/src/index.ts` 追加：

```ts
export * from './approvals/hash';
export * from './approvals/approvals';
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run packages/core/test/approvals.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): 内容哈希与确认记录"
```

---

### Task 4: 工作流门禁

**Files:**
- Create: `packages/core/src/workflow/gate.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/gate.test.ts`

**Interfaces:**
- Consumes: `Approvals.state`（Task 3）、`Clause`、`TestCase`（Task 1）
- Produces:
  - `class GateError extends Error { readonly blockers: string[] }`
  - `interface Blocked { id: string; reason: string }`、`interface Selection<T> { ready: T[]; blocked: Blocked[] }`
  - `selectPlannableClauses(clauses: Clause[], approvals: Approvals): Selection<Clause>`
  - `selectExecutableCases(cases: TestCase[], clauses: Clause[], approvals: Approvals): Selection<TestCase>`
  - `assertProfileApproved(files: Record<string, unknown>, approvals: Approvals): void`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  Approvals,
  assertProfileApproved,
  GateError,
  selectExecutableCases,
  selectPlannableClauses,
  type Clause,
  type TestCase,
} from '../src/index';

const mkClause = (id: string, status: Clause['status'] = 'active'): Clause => ({
  id,
  text: `条款 ${id}`,
  source: { file: 'a.md', line: 1, excerpt: '' },
  status,
  notes: '',
});

const mkCase = (id: string, covers: string[]): TestCase => ({
  id,
  covers,
  fixtures: [],
  actor: 'member',
  steps: ['步骤'],
  expectations: [{ id: 'E1', text: '预期', evidence: ['screenshot'] }],
});

describe('selectPlannableClauses', () => {
  it('只有已确认且 active 的条款可以生成用例', () => {
    const a = Approvals.empty();
    const ok = mkClause('M-AC-1');
    const unapproved = mkClause('M-AC-2');
    const unclear = mkClause('M-AC-3', 'unclear');
    a.approve('clause', ok.id, ok, 'u');
    a.approve('clause', unclear.id, unclear, 'u');
    const sel = selectPlannableClauses([ok, unapproved, unclear], a);
    expect(sel.ready.map((c) => c.id)).toEqual(['M-AC-1']);
    expect(sel.blocked).toEqual([
      { id: 'M-AC-2', reason: '未确认' },
      { id: 'M-AC-3', reason: '状态为 unclear' },
    ]);
  });

  it('确认后被修改的条款不可用', () => {
    const a = Approvals.empty();
    const c = mkClause('M-AC-1');
    a.approve('clause', c.id, c, 'u');
    const sel = selectPlannableClauses([{ ...c, text: '改了' }], a);
    expect(sel.ready).toEqual([]);
    expect(sel.blocked[0]?.reason).toBe('确认已失效（内容已修改）');
  });
});

describe('selectExecutableCases', () => {
  it('用例本身和它覆盖的条款都必须已确认', () => {
    const a = Approvals.empty();
    const c1 = mkClause('M-AC-1');
    const c2 = mkClause('M-AC-2');
    a.approve('clause', c1.id, c1, 'u');
    const t1 = mkCase('M-TC-1', ['M-AC-1']);
    const t2 = mkCase('M-TC-2', ['M-AC-1', 'M-AC-2']);
    const t3 = mkCase('M-TC-3', ['M-AC-1']);
    a.approve('case', t1.id, t1, 'u');
    a.approve('case', t2.id, t2, 'u');
    const sel = selectExecutableCases([t1, t2, t3], [c1, c2], a);
    expect(sel.ready.map((t) => t.id)).toEqual(['M-TC-1']);
    expect(sel.blocked).toEqual([
      { id: 'M-TC-2', reason: '覆盖的条款不可用：M-AC-2' },
      { id: 'M-TC-3', reason: '未确认' },
    ]);
  });

  it('修改已确认用例后不可执行', () => {
    const a = Approvals.empty();
    const c1 = mkClause('M-AC-1');
    a.approve('clause', c1.id, c1, 'u');
    const t1 = mkCase('M-TC-1', ['M-AC-1']);
    a.approve('case', t1.id, t1, 'u');
    const sel = selectExecutableCases([{ ...t1, steps: ['别的步骤'] }], [c1], a);
    expect(sel.ready).toEqual([]);
  });
});

describe('assertProfileApproved', () => {
  it('全部画像文件已确认时通过', () => {
    const a = Approvals.empty();
    a.approve('profile', 'auth.yaml', { x: 1 }, 'u');
    expect(() => assertProfileApproved({ 'auth.yaml': { x: 1 } }, a)).not.toThrow();
  });

  it('有未确认或失效的文件时抛出 GateError 并列出原因', () => {
    const a = Approvals.empty();
    a.approve('profile', 'auth.yaml', { x: 1 }, 'u');
    try {
      assertProfileApproved({ 'auth.yaml': { x: 2 }, 'pages.yaml': {} }, a);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GateError);
      expect((err as GateError).blockers).toEqual(['auth.yaml：确认已失效（内容已修改）', 'pages.yaml：未确认']);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/core/test/gate.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/core/src/workflow/gate.ts`:

```ts
import type { Approvals, ApprovalState } from '../approvals/approvals';
import type { Clause, TestCase } from '../schema/artifacts';

export class GateError extends Error {
  override name = 'GateError';
  constructor(
    message: string,
    readonly blockers: string[],
  ) {
    super(`${message}：\n${blockers.map((b) => `  - ${b}`).join('\n')}`);
  }
}

export interface Blocked {
  id: string;
  reason: string;
}

export interface Selection<T> {
  ready: T[];
  blocked: Blocked[];
}

const STATE_REASON: Record<Exclude<ApprovalState, 'approved'>, string> = {
  none: '未确认',
  stale: '确认已失效（内容已修改）',
};

/** 只有已确认、且状态为 active 的条款才能生成用例 */
export function selectPlannableClauses(clauses: Clause[], approvals: Approvals): Selection<Clause> {
  const sel: Selection<Clause> = { ready: [], blocked: [] };
  for (const c of clauses) {
    if (c.status !== 'active') {
      sel.blocked.push({ id: c.id, reason: `状态为 ${c.status}` });
      continue;
    }
    const st = approvals.state('clause', c.id, c);
    if (st !== 'approved') sel.blocked.push({ id: c.id, reason: STATE_REASON[st] });
    else sel.ready.push(c);
  }
  return sel;
}

/** 只有已确认、且覆盖的条款全部可用的用例才能执行 */
export function selectExecutableCases(
  cases: TestCase[],
  clauses: Clause[],
  approvals: Approvals,
): Selection<TestCase> {
  const usable = new Set(selectPlannableClauses(clauses, approvals).ready.map((c) => c.id));
  const sel: Selection<TestCase> = { ready: [], blocked: [] };
  for (const tc of cases) {
    const st = approvals.state('case', tc.id, tc);
    if (st !== 'approved') {
      sel.blocked.push({ id: tc.id, reason: STATE_REASON[st] });
      continue;
    }
    const missing = tc.covers.filter((id) => !usable.has(id));
    if (missing.length > 0) sel.blocked.push({ id: tc.id, reason: `覆盖的条款不可用：${missing.join(', ')}` });
    else sel.ready.push(tc);
  }
  return sel;
}

/** 画像文件（文件名 → 内容）必须全部已确认 */
export function assertProfileApproved(files: Record<string, unknown>, approvals: Approvals): void {
  const blockers: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const st = approvals.state('profile', name, content);
    if (st !== 'approved') blockers.push(`${name}：${STATE_REASON[st]}`);
  }
  if (blockers.length > 0) throw new GateError('系统画像尚未全部确认', blockers);
}
```

`packages/core/src/index.ts` 追加：

```ts
export * from './workflow/gate';
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run packages/core/test/gate.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): 工作流门禁"
```

---

### Task 5: 证据守卫与合议

**Files:**
- Create: `packages/core/src/verdict/evidence-guard.ts`, `packages/core/src/verdict/consensus.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/verdict.test.ts`

**Interfaces:**
- Consumes: `Judgement`、`Expectation`、`EvidenceRecord`、`ExpectationStatus`（Task 1）
- Produces:
  - `type GuardResult = { ok: true } | { ok: false; reason: string }`（本任务定义，Task 6 复用）
  - `type EvidenceIndex = ReadonlyMap<string, EvidenceRecord>`
  - `checkJudgement(j: Judgement, exp: Expectation, index: EvidenceIndex): GuardResult`
  - `SEVERITY: Record<ExpectationStatus, number>`
  - `decide(exec: Judgement | null, review: Judgement | null): ExpectationStatus`（`null` 表示该方判定无效或缺失）
  - `worstStatus(statuses: ExpectationStatus[]): ExpectationStatus`
  - `exitCodeFor(caseStatuses: ExpectationStatus[]): 0 | 1 | 2`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/verdict.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  checkJudgement,
  decide,
  exitCodeFor,
  worstStatus,
  type EvidenceRecord,
  type Expectation,
  type Judgement,
} from '../src/index';

const exp: Expectation = { id: 'E1', text: '列出身份', evidence: ['screenshot', 'dom'] };
const index = new Map<string, EvidenceRecord>([
  ['ev-1', { id: 'ev-1', type: 'screenshot' }],
  ['ev-2', { id: 'ev-2', type: 'dom' }],
  ['ev-3', { id: 'ev-3', type: 'network' }],
]);
const j = (over: Partial<Judgement> = {}): Judgement => ({
  expectationId: 'E1',
  verdict: 'pass',
  evidenceIds: ['ev-1', 'ev-2'],
  reasoning: '截图中可见',
  ...over,
});

describe('checkJudgement', () => {
  it('证据存在且类型齐全时有效', () => {
    expect(checkJudgement(j(), exp, index)).toEqual({ ok: true });
  });

  it('没有引用证据时作废', () => {
    const r = checkJudgement(j({ evidenceIds: [] }), exp, index);
    expect(r.ok).toBe(false);
  });

  it('引用不存在的证据时作废', () => {
    const r = checkJudgement(j({ evidenceIds: ['ev-1', 'ev-2', 'ev-9'] }), exp, index);
    expect(r).toEqual({ ok: false, reason: '引用了不存在的证据：ev-9' });
  });

  it('缺少要求的证据类型时作废', () => {
    const r = checkJudgement(j({ evidenceIds: ['ev-1', 'ev-3'] }), exp, index);
    expect(r).toEqual({ ok: false, reason: '缺少要求的证据类型：dom' });
  });

  it('预期 id 不匹配时作废', () => {
    expect(checkJudgement(j({ expectationId: 'E2' }), exp, index).ok).toBe(false);
  });

  it('推理为空时作废', () => {
    expect(checkJudgement(j({ reasoning: '  ' }), exp, index).ok).toBe(false);
  });

  it('unclear 判定可以不附证据，但必须说明理由', () => {
    expect(checkJudgement(j({ verdict: 'unclear', evidenceIds: [] }), exp, index)).toEqual({ ok: true });
  });
});

describe('decide', () => {
  const pass = j();
  const fail = j({ verdict: 'fail' });
  const unclear = j({ verdict: 'unclear' });

  it.each([
    [pass, pass, 'PASS'],
    [fail, fail, 'FAIL'],
    [pass, fail, 'DISPUTED'],
    [fail, pass, 'DISPUTED'],
    [unclear, pass, 'UNCLEAR'],
    [fail, unclear, 'UNCLEAR'],
    [null, pass, 'BLOCKED'],
    [pass, null, 'BLOCKED'],
  ] as const)('%#', (a, b, expected) => {
    expect(decide(a, b)).toBe(expected);
  });
});

describe('worstStatus / exitCodeFor', () => {
  it('取最严重的状态', () => {
    expect(worstStatus(['PASS', 'UNCLEAR', 'DISPUTED'])).toBe('DISPUTED');
    expect(worstStatus(['FAIL', 'BLOCKED'])).toBe('BLOCKED');
    expect(worstStatus(['PASS'])).toBe('PASS');
  });

  it('没有任何预期结果时视为 BLOCKED', () => {
    expect(worstStatus([])).toBe('BLOCKED');
  });

  it('退出码', () => {
    expect(exitCodeFor(['PASS', 'PASS'])).toBe(0);
    expect(exitCodeFor(['PASS', 'FAIL', 'BLOCKED'])).toBe(1);
    expect(exitCodeFor(['PASS', 'DISPUTED'])).toBe(2);
    expect(exitCodeFor(['UNCLEAR'])).toBe(2);
    expect(exitCodeFor([])).toBe(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/core/test/verdict.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/core/src/verdict/evidence-guard.ts`:

```ts
import type { Expectation } from '../schema/artifacts';
import type { EvidenceRecord, Judgement } from '../schema/verdict';

export type GuardResult = { ok: true } | { ok: false; reason: string };
export type EvidenceIndex = ReadonlyMap<string, EvidenceRecord>;

/** 判定必须引用真实存在的证据，且覆盖预期要求的全部证据类型 */
export function checkJudgement(j: Judgement, exp: Expectation, index: EvidenceIndex): GuardResult {
  if (j.expectationId !== exp.id) {
    return { ok: false, reason: `判定的预期 id ${j.expectationId} 与 ${exp.id} 不符` };
  }
  if (j.reasoning.trim() === '') return { ok: false, reason: '缺少判定理由' };
  // 条款模糊无法判定时，不强制附证据
  if (j.verdict === 'unclear') return { ok: true };

  if (j.evidenceIds.length === 0) return { ok: false, reason: '判定没有引用任何证据' };
  const missing = j.evidenceIds.filter((id) => !index.has(id));
  if (missing.length > 0) return { ok: false, reason: `引用了不存在的证据：${missing.join(', ')}` };

  const cited = new Set(j.evidenceIds.map((id) => index.get(id)!.type));
  const lacking = exp.evidence.filter((t) => !cited.has(t));
  if (lacking.length > 0) return { ok: false, reason: `缺少要求的证据类型：${lacking.join(', ')}` };
  return { ok: true };
}
```

`packages/core/src/verdict/consensus.ts`:

```ts
import type { ExpectationStatus, Judgement } from '../schema/verdict';

export const SEVERITY: Record<ExpectationStatus, number> = {
  PASS: 0,
  UNCLEAR: 1,
  DISPUTED: 2,
  FAIL: 3,
  BLOCKED: 4,
};

/** 合议：null 表示该方判定缺失或已作废 */
export function decide(exec: Judgement | null, review: Judgement | null): ExpectationStatus {
  if (!exec || !review) return 'BLOCKED';
  if (exec.verdict === 'unclear' || review.verdict === 'unclear') return 'UNCLEAR';
  if (exec.verdict !== review.verdict) return 'DISPUTED';
  return exec.verdict === 'pass' ? 'PASS' : 'FAIL';
}

/** 用例结果取所有预期中最严重的状态；没有任何结果视为 BLOCKED */
export function worstStatus(statuses: ExpectationStatus[]): ExpectationStatus {
  if (statuses.length === 0) return 'BLOCKED';
  return statuses.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
}

/** 0 全部通过；1 有 FAIL；2 有 DISPUTED/UNCLEAR/BLOCKED 或没有执行任何用例 */
export function exitCodeFor(caseStatuses: ExpectationStatus[]): 0 | 1 | 2 {
  if (caseStatuses.includes('FAIL')) return 1;
  if (caseStatuses.length === 0 || caseStatuses.some((s) => s !== 'PASS')) return 2;
  return 0;
}
```

`packages/core/src/index.ts` 追加：

```ts
export * from './verdict/evidence-guard';
export * from './verdict/consensus';
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run packages/core/test/verdict.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): 证据守卫与合议规则"
```

---

### Task 6: URL 守卫与只读 SQL 守卫

**Files:**
- Create: `packages/core/src/guard/url-guard.ts`, `packages/core/src/guard/sql-guard.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/guards.test.ts`

**Interfaces:**
- Consumes: `Guardrails`（Task 1）、`GuardResult`（Task 5）
- Produces:
  - `checkRequest(req: { url: string; method?: string }, g: Guardrails): GuardResult`
  - `checkReadonlySql(sql: string): GuardResult`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/guards.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checkReadonlySql, checkRequest, type Guardrails } from '../src/index';

const g: Guardrails = {
  allowedHosts: ['localhost:3000', '127.0.0.1', '*.staging.example.com'],
  forbidden: [
    { method: 'DELETE', path: '/api/**' },
    { path: '/admin/danger/*' },
  ],
  redactFields: [],
};

describe('checkRequest', () => {
  it.each([
    ['http://localhost:3000/api/x', true],
    ['http://localhost:4000/api/x', false],
    ['http://127.0.0.1:8080/', true],
    ['https://a.staging.example.com/', true],
    ['https://staging.example.com/', false],
    ['https://evil.com/', false],
    ['file:///etc/passwd', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => {
    expect(checkRequest({ url }, g).ok).toBe(ok);
  });

  it('禁止的方法和路径', () => {
    expect(checkRequest({ url: 'http://localhost:3000/api/orders/1', method: 'delete' }, g).ok).toBe(false);
    expect(checkRequest({ url: 'http://localhost:3000/api/orders/1', method: 'GET' }, g).ok).toBe(true);
  });

  it('未写方法的禁止规则匹配任意方法，* 只匹配单段', () => {
    expect(checkRequest({ url: 'http://localhost:3000/admin/danger/wipe' }, g).ok).toBe(false);
    expect(checkRequest({ url: 'http://localhost:3000/admin/danger/a/b' }, g).ok).toBe(true);
  });

  it('拒绝原因可读', () => {
    expect(checkRequest({ url: 'https://evil.com/' }, g)).toEqual({ ok: false, reason: '主机不在白名单内：evil.com' });
  });
});

describe('checkReadonlySql', () => {
  it.each([
    'SELECT * FROM users WHERE id = 1',
    'select count(*) from orders;',
    'WITH t AS (SELECT 1 AS x) SELECT x FROM t',
    "SELECT * FROM logs WHERE msg = 'please DELETE me; now'",
    'SELECT replace(name, \'a\', \'b\') FROM t -- trailing comment with UPDATE',
  ])('允许：%s', (sql) => {
    expect(checkReadonlySql(sql)).toEqual({ ok: true });
  });

  it.each([
    'DELETE FROM users',
    'UPDATE users SET a = 1',
    'INSERT INTO t VALUES (1)',
    'DROP TABLE t',
    'SELECT 1; DROP TABLE t',
    'SELECT * INTO backup FROM users',
    'SELECT * FROM t FOR UPDATE',
    'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
    'SELECT pg_sleep(10)',
    'TRUNCATE t',
    'SELECT $$x$$',
    '',
  ])('拒绝：%s', (sql) => {
    expect(checkReadonlySql(sql).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/core/test/guards.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/core/src/guard/url-guard.ts`:

```ts
import type { Guardrails } from '../schema/guardrails';
import type { GuardResult } from '../verdict/evidence-guard';

function hostAllowed(url: URL, entry: string): boolean {
  const e = entry.toLowerCase();
  const host = url.hostname.toLowerCase();
  const [pattern, port] = e.startsWith('[') ? [e, undefined] : (e.split(':') as [string, string | undefined]);
  if (port !== undefined) {
    const actualPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (actualPort !== port) return false;
  }
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

/** `**` 匹配任意多段，`*` 只匹配单段内的字符 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (ch === '*') {
      re += '[^/]*';
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** 校验 HTTP/浏览器请求是否在白名单内，且不命中禁止规则 */
export function checkRequest(req: { url: string; method?: string }, g: Guardrails): GuardResult {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { ok: false, reason: `无法解析的地址：${req.url}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `不允许的协议：${url.protocol}` };
  }
  if (!g.allowedHosts.some((entry) => hostAllowed(url, entry))) {
    return { ok: false, reason: `主机不在白名单内：${url.host}` };
  }
  const method = (req.method ?? 'GET').toUpperCase();
  for (const rule of g.forbidden) {
    if (rule.method && rule.method.toUpperCase() !== method) continue;
    if (globToRegExp(rule.path).test(url.pathname)) {
      return { ok: false, reason: `命中禁止规则：${rule.method ?? '任意方法'} ${rule.path}` };
    }
  }
  return { ok: true };
}
```

`packages/core/src/guard/sql-guard.ts`:

```ts
import type { GuardResult } from '../verdict/evidence-guard';

const FORBIDDEN_WORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|CALL|EXEC|EXECUTE|COPY|LOCK|INTO|ATTACH|DETACH|PRAGMA|VACUUM|LOAD|HANDLER|SET|RENAME|COMMENT|REINDEX|CLUSTER|REFRESH|NOTIFY|LISTEN)\b/i;

const FORBIDDEN_FUNCS =
  /\b(pg_sleep\w*|sleep|benchmark|dblink\w*|lo_\w+|pg_read_\w+|pg_write_\w+|pg_ls_dir|load_file|pg_terminate_backend|pg_cancel_backend|set_config|nextval|setval)\s*\(/i;

/** 去掉注释与字符串/标识符字面量，剩下的才是需要检查的 SQL 结构 */
function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``');
}

/**
 * 只读 SQL 校验（保守策略，宁可误拒）。
 * 这是第一道防线；数据库工具还会在只读事务/只读账号中执行（计划 2）。
 */
export function checkReadonlySql(sql: string): GuardResult {
  if (sql.includes('$$') || /\$[A-Za-z_]\w*\$/.test(sql)) {
    return { ok: false, reason: '不允许使用美元符引号' };
  }
  let body = stripLiterals(sql).trim();
  if (body.endsWith(';')) body = body.slice(0, -1).trim();
  if (body === '') return { ok: false, reason: 'SQL 为空' };
  if (body.includes(';')) return { ok: false, reason: '只允许单条语句' };
  if (!/^(SELECT|WITH)\b/i.test(body)) return { ok: false, reason: '只允许 SELECT 或 WITH 开头的查询' };
  const word = FORBIDDEN_WORDS.exec(body);
  if (word) return { ok: false, reason: `包含禁止的关键字：${word[1]!.toUpperCase()}` };
  const fn = FORBIDDEN_FUNCS.exec(body);
  if (fn) return { ok: false, reason: `包含禁止的函数：${fn[1]}` };
  return { ok: true };
}
```

`packages/core/src/index.ts` 追加：

```ts
export * from './guard/url-guard';
export * from './guard/sql-guard';
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run packages/core/test/guards.test.ts && pnpm typecheck`
Expected: PASS。如果某个“允许”用例因为 `SET` 等关键字被误拒，检查它是否出现在字符串或注释之外；不要为了让测试通过而放宽禁止列表。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): 地址白名单与只读 SQL 守卫"
```

---

### Task 7: 脱敏与预算

**Files:**
- Create: `packages/core/src/redact/redact.ts`, `packages/core/src/budget/budget.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/redact.test.ts`, `packages/core/test/budget.test.ts`

**Interfaces:**
- Consumes: `BudgetLimits`（Task 1）
- Produces:
  - `REDACTED = '[REDACTED]'`
  - `interface Redactor { headers(h: Record<string, string | string[]>): Record<string, string | string[]>; value<T>(v: T): T; text(body: string, contentType?: string): string; url(u: string): string }`
  - `createRedactor(extraFields?: string[]): Redactor`
  - `class BudgetTracker { constructor(limits: BudgetLimits, now?: () => number); recordStep(): void; recordTokens(n: number): void; exhausted(): string | null; snapshot(): { steps: number; tokens: number; elapsedMs: number } }`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createRedactor, REDACTED } from '../src/index';

const r = createRedactor(['idCard']);

describe('Redactor', () => {
  it('敏感请求头不区分大小写', () => {
    expect(r.headers({ Authorization: 'Bearer x', 'set-cookie': ['a=1', 'b=2'], Accept: '*/*' })).toEqual({
      Authorization: REDACTED,
      'set-cookie': [REDACTED, REDACTED],
      Accept: '*/*',
    });
  });

  it('深层对象中的密码与登记字段', () => {
    const input = { user: { name: 'a', password: 'p', IDCARD: '110' }, list: [{ newPassword: 'q' }] };
    expect(r.value(input)).toEqual({ user: { name: 'a', password: REDACTED, IDCARD: REDACTED }, list: [{ newPassword: REDACTED }] });
    expect(input.user.password).toBe('p'); // 不修改原对象
  });

  it('JSON 文本', () => {
    expect(JSON.parse(r.text('{"password":"p","a":1}', 'application/json; charset=utf-8'))).toEqual({ password: REDACTED, a: 1 });
  });

  it('表单文本', () => {
    expect(r.text('user=a&password=p', 'application/x-www-form-urlencoded')).toBe(`user=a&password=${encodeURIComponent(REDACTED)}`);
  });

  it('其他文本原样返回，非法 JSON 不抛错', () => {
    expect(r.text('hello', 'text/plain')).toBe('hello');
    expect(r.text('{bad', 'application/json')).toBe('{bad');
  });

  it('URL 查询参数', () => {
    expect(r.url('http://h/x?token=1&password=2&idcard=3')).toBe(
      `http://h/x?token=1&password=${encodeURIComponent(REDACTED)}&idcard=${encodeURIComponent(REDACTED)}`,
    );
  });
});
```

`packages/core/test/budget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BudgetTracker } from '../src/index';

describe('BudgetTracker', () => {
  const limits = { steps: 2, tokens: 100, minutes: 1 };

  it('未超出时返回 null', () => {
    const b = new BudgetTracker(limits, () => 0);
    b.recordStep();
    b.recordTokens(50);
    expect(b.exhausted()).toBeNull();
    expect(b.snapshot()).toEqual({ steps: 1, tokens: 50, elapsedMs: 0 });
  });

  it('步数用尽', () => {
    const b = new BudgetTracker(limits, () => 0);
    b.recordStep();
    b.recordStep();
    expect(b.exhausted()).toBe('步数预算耗尽（2/2）');
  });

  it('token 用尽', () => {
    const b = new BudgetTracker(limits, () => 0);
    b.recordTokens(100);
    expect(b.exhausted()).toBe('token 预算耗尽（100/100）');
  });

  it('时长用尽', () => {
    let t = 1000;
    const b = new BudgetTracker(limits, () => t);
    t += 60_000;
    expect(b.exhausted()).toBe('时长预算耗尽（1 分钟）');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/core/test/redact.test.ts packages/core/test/budget.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/core/src/redact/redact.ts`:

```ts
export const REDACTED = '[REDACTED]';

const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
const DEFAULT_FIELDS = ['password', 'passwd', 'pwd'];

export interface Redactor {
  headers(h: Record<string, string | string[]>): Record<string, string | string[]>;
  value<T>(v: T): T;
  text(body: string, contentType?: string): string;
  url(u: string): string;
}

/** 证据落盘前统一脱敏；extraFields 来自 guardrails.yaml 的 redactFields */
export function createRedactor(extraFields: string[] = []): Redactor {
  const fields = new Set([...DEFAULT_FIELDS, ...extraFields].map((f) => f.toLowerCase()));
  // 字段名包含 password 的也一律脱敏（如 newPassword）
  const isSensitive = (key: string): boolean => {
    const k = key.toLowerCase();
    return fields.has(k) || k.includes('password');
  };

  const value = <T>(v: T): T => {
    if (Array.isArray(v)) return v.map((x) => value(x)) as T;
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = isSensitive(k) ? REDACTED : value(x);
      return out as T;
    }
    return v;
  };

  const params = (p: URLSearchParams): URLSearchParams => {
    const out = new URLSearchParams();
    for (const [k, x] of p) out.append(k, isSensitive(k) ? REDACTED : x);
    return out;
  };

  return {
    headers(h) {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(h)) {
        const hit = SENSITIVE_HEADERS.has(k.toLowerCase()) || isSensitive(k);
        out[k] = hit ? (Array.isArray(v) ? v.map(() => REDACTED) : REDACTED) : v;
      }
      return out;
    },
    value,
    text(body, contentType = '') {
      const ct = contentType.toLowerCase();
      if (ct.includes('json')) {
        try {
          return JSON.stringify(value(JSON.parse(body)));
        } catch {
          return body;
        }
      }
      if (ct.includes('application/x-www-form-urlencoded')) return params(new URLSearchParams(body)).toString();
      return body;
    },
    url(u) {
      try {
        const url = new URL(u);
        url.search = params(url.searchParams).toString();
        return url.toString();
      } catch {
        return u;
      }
    },
  };
}
```

`packages/core/src/budget/budget.ts`:

```ts
import type { BudgetLimits } from '../schema/config';

/** 单个用例的步数 / token / 时长预算 */
export class BudgetTracker {
  private steps = 0;
  private tokens = 0;
  private readonly startedAt: number;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  recordStep(): void {
    this.steps++;
  }

  recordTokens(n: number): void {
    this.tokens += n;
  }

  /** 已耗尽时返回原因，否则返回 null */
  exhausted(): string | null {
    const { steps, tokens, minutes } = this.limits;
    if (this.steps >= steps) return `步数预算耗尽（${this.steps}/${steps}）`;
    if (this.tokens >= tokens) return `token 预算耗尽（${this.tokens}/${tokens}）`;
    if (this.now() - this.startedAt >= minutes * 60_000) return `时长预算耗尽（${minutes} 分钟）`;
    return null;
  }

  snapshot(): { steps: number; tokens: number; elapsedMs: number } {
    return { steps: this.steps, tokens: this.tokens, elapsedMs: this.now() - this.startedAt };
  }
}
```

`packages/core/src/index.ts` 追加：

```ts
export * from './redact/redact';
export * from './budget/budget';
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: core 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): 证据脱敏与用例预算"
```

---

### Task 8: models —— 模型引用解析与按角色解析

**Files:**
- Create: `packages/models/package.json`, `packages/models/src/model-ref.ts`, `src/providers.ts`, `src/resolve.ts`, `src/index.ts`
- Test: `packages/models/test/resolve.test.ts`

**Interfaces:**
- Consumes: `Config`、`Role`、`ProviderType`、`PROVIDER_TYPES`（Task 1）
- Produces:
  - `parseModelRef(ref: string): { provider: string; modelId: string }`
  - `interface ProviderSettings { name: string; modelId: string; apiKey?: string; baseURL?: string }`
  - `type ProviderFactory = (s: ProviderSettings) => LanguageModel`（`LanguageModel` 来自 `ai`）
  - `builtinFactories: Record<ProviderType, ProviderFactory>`、`DEFAULT_KEY_ENV`
  - `interface ModelCandidate { ref: string; model: LanguageModel }`
  - `interface ResolveOptions { env?: Record<string, string | undefined>; factories?: Partial<Record<ProviderType, ProviderFactory>> }`
  - `class ModelConfigError extends Error`
  - `resolveModelRef(ref: string, config: Config, opts?: ResolveOptions): ModelCandidate`
  - `resolveRole(config: Config, role: Role, opts?: ResolveOptions): ModelCandidate[]`（主模型在前，备用模型在后）
  - `vendorWarnings(config: Config): string[]`

- [ ] **Step 1: 建包并安装依赖**

`packages/models/package.json`:

```json
{
  "name": "@crosscheck/models",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

Run:
```bash
pnpm --filter @crosscheck/models add ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google @ai-sdk/deepseek @ai-sdk/openai-compatible zod "@crosscheck/core@workspace:*"
```
Expected: `ai` 为 7.x；各 `@ai-sdk/*` 为与 ai 7 配套的版本（pnpm 会提示 peer 依赖不匹配时，按提示对齐版本）。

- [ ] **Step 2: 写失败的测试**

`packages/models/test/resolve.test.ts`:

```ts
import { ConfigSchema } from '@crosscheck/core';
import { describe, expect, it } from 'vitest';
import {
  ModelConfigError,
  parseModelRef,
  resolveRole,
  vendorWarnings,
  type ProviderFactory,
  type ProviderSettings,
} from '../src/index';

const seen: ProviderSettings[] = [];
// 假工厂：记录参数，返回字符串作为模型（LanguageModel 类型允许字符串）
const fake: ProviderFactory = (s) => {
  seen.push(s);
  return `${s.name}/${s.modelId}`;
};
const factories = {
  anthropic: fake,
  openai: fake,
  google: fake,
  deepseek: fake,
  ollama: fake,
  'openai-compatible': fake,
};

const config = ConfigSchema.parse({
  models: {
    extractor: 'anthropic:claude-sonnet-4-6',
    planner: 'ollama:qwen2.5:7b',
    executor: 'openai:gpt-5.4',
    reviewer: 'qwen:qwen-max',
    fallback: { executor: 'anthropic:claude-sonnet-4-6' },
  },
  providers: {
    qwen: { type: 'openai-compatible', baseURL: 'https://dashscope.example/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' },
  },
});

const env = { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a', DASHSCOPE_API_KEY: 'sk-q' };

describe('parseModelRef', () => {
  it('只在第一个冒号处切分', () => {
    expect(parseModelRef('ollama:qwen2.5:7b')).toEqual({ provider: 'ollama', modelId: 'qwen2.5:7b' });
  });

  it('格式错误时报错', () => {
    expect(() => parseModelRef('gpt')).toThrow(ModelConfigError);
  });
});

describe('resolveRole', () => {
  it('主模型在前、备用模型在后', () => {
    const c = resolveRole(config, 'executor', { env, factories });
    expect(c.map((x) => x.ref)).toEqual(['openai:gpt-5.4', 'anthropic:claude-sonnet-4-6']);
    expect(c[0]?.model).toBe('openai/gpt-5.4');
  });

  it('密钥从配置指定的环境变量读取', () => {
    seen.length = 0;
    resolveRole(config, 'reviewer', { env, factories });
    expect(seen[0]).toEqual({ name: 'qwen', modelId: 'qwen-max', apiKey: 'sk-q', baseURL: 'https://dashscope.example/v1' });
  });

  it('ollama 不需要密钥', () => {
    expect(resolveRole(config, 'planner', { env: {}, factories })[0]?.ref).toBe('ollama:qwen2.5:7b');
  });

  it('缺少环境变量时给出可读错误', () => {
    expect(() => resolveRole(config, 'executor', { env: {}, factories })).toThrow(/OPENAI_API_KEY/);
  });

  it('未知的 provider 报错', () => {
    const bad = ConfigSchema.parse({ ...config, models: { ...config.models, reviewer: 'nope:x' } });
    expect(() => resolveRole(bad, 'reviewer', { env, factories })).toThrow(/未知的 provider：nope/);
  });
});

describe('vendorWarnings', () => {
  it('executor 与 reviewer 同厂商时警告', () => {
    const same = ConfigSchema.parse({ ...config, models: { ...config.models, reviewer: 'openai:gpt-5.4-mini' } });
    expect(vendorWarnings(same)).toHaveLength(1);
    expect(vendorWarnings(config)).toEqual([]);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run packages/models/test/resolve.test.ts`
Expected: FAIL。

- [ ] **Step 4: 实现**

`packages/models/src/model-ref.ts`:

```ts
export class ModelConfigError extends Error {
  override name = 'ModelConfigError';
}

/** 解析 provider:model；只在第一个冒号处切分 */
export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) throw new ModelConfigError(`模型引用格式应为 provider:model：${ref}`);
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}
```

`packages/models/src/providers.ts`:

```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ProviderType } from '@crosscheck/core';
import type { LanguageModel } from 'ai';
import { ModelConfigError } from './model-ref';

export interface ProviderSettings {
  name: string;
  modelId: string;
  apiKey?: string;
  baseURL?: string;
}

export type ProviderFactory = (s: ProviderSettings) => LanguageModel;

/** 内置 provider 默认读取的环境变量 */
export const DEFAULT_KEY_ENV: Partial<Record<ProviderType, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export const builtinFactories: Record<ProviderType, ProviderFactory> = {
  anthropic: (s) => createAnthropic({ apiKey: s.apiKey, baseURL: s.baseURL })(s.modelId),
  openai: (s) => createOpenAI({ apiKey: s.apiKey, baseURL: s.baseURL })(s.modelId),
  google: (s) => createGoogleGenerativeAI({ apiKey: s.apiKey, baseURL: s.baseURL })(s.modelId),
  deepseek: (s) => createDeepSeek({ apiKey: s.apiKey, baseURL: s.baseURL })(s.modelId),
  // Ollama 走它的 OpenAI 兼容接口
  ollama: (s) =>
    createOpenAICompatible({ name: s.name, baseURL: s.baseURL ?? 'http://localhost:11434/v1', apiKey: s.apiKey })(
      s.modelId,
    ),
  'openai-compatible': (s) => {
    if (!s.baseURL) throw new ModelConfigError(`provider ${s.name} 是 openai-compatible，必须配置 baseURL`);
    return createOpenAICompatible({ name: s.name, baseURL: s.baseURL, apiKey: s.apiKey })(s.modelId);
  },
};
```

`packages/models/src/resolve.ts`:

```ts
import { PROVIDER_TYPES, type Config, type ProviderType, type Role } from '@crosscheck/core';
import type { LanguageModel } from 'ai';
import { ModelConfigError, parseModelRef } from './model-ref';
import { builtinFactories, DEFAULT_KEY_ENV, type ProviderFactory } from './providers';

export interface ModelCandidate {
  ref: string;
  model: LanguageModel;
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  factories?: Partial<Record<ProviderType, ProviderFactory>>;
}

function isBuiltin(name: string): name is ProviderType {
  return (PROVIDER_TYPES as readonly string[]).includes(name) && name !== 'openai-compatible';
}

export function resolveModelRef(ref: string, config: Config, opts: ResolveOptions = {}): ModelCandidate {
  const env = opts.env ?? process.env;
  const { provider, modelId } = parseModelRef(ref);
  const custom = config.providers[provider];
  let type: ProviderType;
  if (custom) type = custom.type;
  else if (isBuiltin(provider)) type = provider;
  else throw new ModelConfigError(`未知的 provider：${provider}（请在 config.yaml 的 providers 中声明）`);

  const keyEnv = custom?.apiKeyEnv ?? DEFAULT_KEY_ENV[type];
  let apiKey: string | undefined;
  if (keyEnv) {
    apiKey = env[keyEnv];
    if (!apiKey) throw new ModelConfigError(`模型 ${ref} 需要环境变量 ${keyEnv}`);
  }
  const factory = opts.factories?.[type] ?? builtinFactories[type];
  const model = factory({ name: provider, modelId, apiKey, baseURL: custom?.baseURL });
  return { ref, model };
}

/** 角色的候选模型：主模型在前，备用模型（若配置）在后 */
export function resolveRole(config: Config, role: Role, opts: ResolveOptions = {}): ModelCandidate[] {
  const refs = [config.models[role], config.models.fallback[role]].filter((r): r is string => !!r);
  return refs.map((r) => resolveModelRef(r, config, opts));
}

/** executor 与 reviewer 同厂商时给出警告（不阻止运行） */
export function vendorWarnings(config: Config): string[] {
  const a = parseModelRef(config.models.executor).provider;
  const b = parseModelRef(config.models.reviewer).provider;
  return a === b ? [`executor 与 reviewer 都使用 ${a}，交叉复核的独立性会减弱，建议换成不同厂商`] : [];
}
```

`packages/models/src/index.ts`:

```ts
export * from './model-ref';
export * from './providers';
export * from './resolve';
```

- [ ] **Step 5: 运行测试**

Run: `pnpm vitest run packages/models && pnpm typecheck`
Expected: PASS。若 tsc 报某个 `create*` 不接受 `baseURL: undefined`，改成按需展开：`createX({ ...(s.apiKey && { apiKey: s.apiKey }), ...(s.baseURL && { baseURL: s.baseURL }) })`。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(models): 按角色解析模型"
```

---

### Task 9: models —— 重试、备用模型与用量统计

**Files:**
- Create: `packages/models/src/resilience.ts`, `packages/models/src/usage.ts`
- Modify: `packages/models/src/index.ts`
- Test: `packages/models/test/resilience.test.ts`, `packages/models/test/usage.test.ts`

**Interfaces:**
- Consumes: `ModelCandidate`（Task 8）、`Config['pricing']`（Task 1）
- Produces:
  - `interface ResilienceOptions { retries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void>; isRetryable?: (err: unknown) => boolean; onFallback?: (from: string, to: string, err: unknown) => void }`
  - `callWithFallback<T>(chain: ModelCandidate[], fn: (model: LanguageModel, ref: string) => Promise<T>, opts?: ResilienceOptions): Promise<{ value: T; ref: string; attempts: number }>`
  - `class UsageMeter { constructor(pricing?: Config['pricing']); add(role: string, ref: string, usage: { inputTokens?: number; outputTokens?: number }): void; totals(): UsageTotals }`
  - `interface UsageTotals { inputTokens: number; outputTokens: number; cost: number; byRole: Record<string, { inputTokens: number; outputTokens: number; cost: number }> }`

- [ ] **Step 1: 写失败的测试**

`packages/models/test/resilience.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { callWithFallback, type ModelCandidate } from '../src/index';

const chain: ModelCandidate[] = [
  { ref: 'a:primary', model: 'primary' },
  { ref: 'b:backup', model: 'backup' },
];

describe('callWithFallback', () => {
  it('失败后指数退避重试', async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    const r = await callWithFallback(
      chain,
      async () => {
        if (++n < 3) throw new Error('503');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 500, sleep },
    );
    expect(r).toEqual({ value: 'ok', ref: 'a:primary', attempts: 3 });
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
  });

  it('主模型连续失败后切换备用模型', async () => {
    const onFallback = vi.fn();
    const r = await callWithFallback(
      chain,
      async (model) => {
        if (model === 'primary') throw new Error('down');
        return 'from backup';
      },
      { retries: 1, sleep: async () => {}, onFallback },
    );
    expect(r).toEqual({ value: 'from backup', ref: 'b:backup', attempts: 3 });
    expect(onFallback).toHaveBeenCalledWith('a:primary', 'b:backup', expect.any(Error));
  });

  it('全部失败时抛出最后一个错误', async () => {
    await expect(
      callWithFallback(chain, async (_m, ref) => Promise.reject(new Error(`fail ${ref}`)), { retries: 0, sleep: async () => {} }),
    ).rejects.toThrow('fail b:backup');
  });

  it('不可重试的错误立即抛出，不切换备用模型', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fn = vi.fn(async () => Promise.reject(abort));
    await expect(callWithFallback(chain, fn, { sleep: async () => {} })).rejects.toBe(abort);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

`packages/models/test/usage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { UsageMeter } from '../src/index';

describe('UsageMeter', () => {
  it('按角色累计 token 与费用', () => {
    const m = new UsageMeter({ 'openai:gpt-5.4': { inputPerMTok: 2, outputPerMTok: 8 } });
    m.add('executor', 'openai:gpt-5.4', { inputTokens: 1_000_000, outputTokens: 500_000 });
    m.add('reviewer', 'qwen:qwen-max', { inputTokens: 10, outputTokens: undefined });
    const t = m.totals();
    expect(t.byRole.executor).toEqual({ inputTokens: 1_000_000, outputTokens: 500_000, cost: 6 });
    expect(t.byRole.reviewer).toEqual({ inputTokens: 10, outputTokens: 0, cost: 0 });
    expect(t).toMatchObject({ inputTokens: 1_000_010, outputTokens: 500_000, cost: 6 });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/models`
Expected: FAIL（新测试）。

- [ ] **Step 3: 实现**

`packages/models/src/resilience.ts`:

```ts
import type { LanguageModel } from 'ai';
import type { ModelCandidate } from './resolve';

export interface ResilienceOptions {
  /** 每个模型的重试次数（不含首次），默认 3 */
  retries?: number;
  /** 首次退避时长，之后每次翻倍，默认 500ms */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (err: unknown) => boolean;
  onFallback?: (from: string, to: string, err: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultRetryable = (err: unknown) => !(err instanceof Error && err.name === 'AbortError');

/** 依次尝试候选模型：每个模型指数退避重试，用尽后切换下一个 */
export async function callWithFallback<T>(
  chain: ModelCandidate[],
  fn: (model: LanguageModel, ref: string) => Promise<T>,
  opts: ResilienceOptions = {},
): Promise<{ value: T; ref: string; attempts: number }> {
  const { retries = 3, baseDelayMs = 500, sleep = defaultSleep, isRetryable = defaultRetryable, onFallback } = opts;
  if (chain.length === 0) throw new Error('没有可用的模型');
  let attempts = 0;
  let lastErr: unknown;
  for (let c = 0; c < chain.length; c++) {
    const { ref, model } = chain[c]!;
    for (let i = 0; i <= retries; i++) {
      attempts++;
      try {
        return { value: await fn(model, ref), ref, attempts };
      } catch (err) {
        if (!isRetryable(err)) throw err;
        lastErr = err;
        if (i < retries) await sleep(baseDelayMs * 2 ** i);
      }
    }
    const next = chain[c + 1];
    if (next) onFallback?.(ref, next.ref, lastErr);
  }
  throw lastErr;
}
```

`packages/models/src/usage.ts`:

```ts
import type { Config } from '@crosscheck/core';

interface Bucket {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageTotals extends Bucket {
  byRole: Record<string, Bucket>;
}

/** 按角色累计 token 与费用（单价按每百万 token 计） */
export class UsageMeter {
  private readonly byRole = new Map<string, Bucket>();

  constructor(private readonly pricing: Config['pricing'] = {}) {}

  add(role: string, ref: string, usage: { inputTokens?: number; outputTokens?: number }): void {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const price = this.pricing[ref];
    const cost = price ? (input * price.inputPerMTok + output * price.outputPerMTok) / 1_000_000 : 0;
    const b = this.byRole.get(role) ?? { inputTokens: 0, outputTokens: 0, cost: 0 };
    b.inputTokens += input;
    b.outputTokens += output;
    b.cost += cost;
    this.byRole.set(role, b);
  }

  totals(): UsageTotals {
    const byRole = Object.fromEntries([...this.byRole].map(([k, v]) => [k, { ...v }]));
    const sum = (f: keyof Bucket) => Object.values(byRole).reduce((s, b) => s + b[f], 0);
    return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cost: sum('cost'), byRole };
  }
}
```

`packages/models/src/index.ts` 追加：

```ts
export * from './resilience';
export * from './usage';
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run packages/models && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(models): 重试、备用模型与用量统计"
```

---

### Task 10: agent —— 假模型、工具定义与阶段授权

**Files:**
- Create: `packages/agent/package.json`, `packages/agent/src/tool.ts`, `src/grants.ts`, `src/testing/scripted-model.ts`, `src/index.ts`
- Test: `packages/agent/test/scripted-model.test.ts`, `packages/agent/test/grants.test.ts`

**Interfaces:**
- Produces:
  - `type ToolCategory = 'browser' | 'http' | 'db' | 'fixture' | 'profile' | 'requirements'`
  - `interface ToolContext { signal: AbortSignal }`
  - `interface AgentTool<I = any> { name: string; category: ToolCategory; description: string; input: z.ZodType<I>; execute(input: I, ctx: ToolContext): Promise<unknown> }`
  - `defineTool<I>(t: AgentTool<I>): AgentTool<I>`（校验名称只含 `[A-Za-z0-9_-]`）
  - `type Stage = 'extract' | 'plan' | 'prepare' | 'execute' | 'review'`
  - `STAGE_GRANTS: Record<Stage, readonly ToolCategory[]>`
  - `grantTools(stage: Stage, tools: AgentTool[]): { granted: AgentTool[]; denied: AgentTool[] }`
  - `type ScriptStep = { text: string } | { toolCalls: Array<{ name: string; input: unknown }> } | { error: Error }`
  - `scriptedModel(steps: ScriptStep[]): MockLanguageModelV4`（从 `@crosscheck/agent/testing` 导出；调用记录见 `model.doGenerateCalls`）

- [ ] **Step 1: 建包并安装依赖**

`packages/agent/package.json`:

```json
{
  "name": "@crosscheck/agent",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing/scripted-model.ts"
  }
}
```

Run:
```bash
pnpm --filter @crosscheck/agent add ai zod "@crosscheck/core@workspace:*" "@crosscheck/models@workspace:*"
```

- [ ] **Step 2: 写失败的测试**

`packages/agent/test/scripted-model.test.ts`:

```ts
import { generateText, jsonSchema, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { scriptedModel } from '../src/testing/scripted-model';

describe('scriptedModel', () => {
  it('按脚本依次返回文本和工具调用', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'echo', input: { x: 1 } }] }, { text: '完成' }]);
    const tools = { echo: tool({ description: 'echo', inputSchema: jsonSchema({ type: 'object' }) }) };

    const r1 = await generateText({ model, prompt: 'hi', tools });
    expect(r1.finishReason).toBe('tool-calls');
    expect(r1.toolCalls[0]).toMatchObject({ toolName: 'echo', input: { x: 1 } });

    const r2 = await generateText({ model, prompt: 'hi' });
    expect(r2.text).toBe('完成');
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('脚本耗尽时报错', async () => {
    const model = scriptedModel([]);
    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow(/脚本已耗尽/);
  });

  it('可以模拟模型调用失败', async () => {
    const model = scriptedModel([{ error: new Error('503') }]);
    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow('503');
  });
});
```

`packages/agent/test/grants.test.ts`:

```ts
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineTool, grantTools, type AgentTool, type ToolCategory } from '../src/index';

const mk = (name: string, category: ToolCategory): AgentTool =>
  defineTool({ name, category, description: name, input: z.object({}), execute: async () => null });

const all = [
  mk('browser_click', 'browser'),
  mk('http_request', 'http'),
  mk('db_query', 'db'),
  mk('fixture_apply', 'fixture'),
  mk('profile_lookup', 'profile'),
  mk('requirements_read', 'requirements'),
];

const names = (ts: AgentTool[]) => ts.map((t) => t.name);

describe('grantTools', () => {
  it('执行阶段不授予夹具工具', () => {
    const { granted, denied } = grantTools('execute', all);
    expect(names(granted)).toEqual(['browser_click', 'http_request', 'db_query', 'profile_lookup']);
    expect(names(denied)).toEqual(['fixture_apply', 'requirements_read']);
  });

  it('生成用例阶段只能读条款和画像，不能操作系统', () => {
    expect(names(grantTools('plan', all).granted)).toEqual(['profile_lookup', 'requirements_read']);
  });

  it('准备阶段可以使用夹具', () => {
    expect(names(grantTools('prepare', all).granted)).toContain('fixture_apply');
  });

  it('复核阶段没有任何工具', () => {
    expect(grantTools('review', all).granted).toEqual([]);
  });
});

describe('defineTool', () => {
  it('拒绝含点号等字符的名称', () => {
    expect(() => mk('profile.lookup', 'profile')).toThrow(/工具名/);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run packages/agent`
Expected: FAIL。

- [ ] **Step 4: 实现**

`packages/agent/src/testing/scripted-model.ts`:

```ts
import { MockLanguageModelV4 } from 'ai/test';

export type ScriptStep =
  | { text: string }
  | { toolCalls: Array<{ name: string; input: unknown }> }
  | { error: Error };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/**
 * 按脚本逐次返回结果的假模型，用于确定性地测试代理循环。
 * 每次 doGenerate 消耗一个脚本步骤；调用记录见 model.doGenerateCalls。
 */
export function scriptedModel(steps: ScriptStep[]): MockLanguageModelV4 {
  let index = 0;
  let callSeq = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[index++];
      if (!step) throw new Error(`脚本已耗尽：第 ${index} 次调用没有预设响应`);
      if ('error' in step) throw step.error;
      if ('text' in step) {
        return {
          content: [{ type: 'text' as const, text: step.text }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: step.toolCalls.map((c) => ({
          type: 'tool-call' as const,
          toolCallId: `call-${++callSeq}`,
          toolName: c.name,
          input: JSON.stringify(c.input),
        })),
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}
```

> 若 tsc 报 `doGenerate` 返回值类型不符，打开 `node_modules/@ai-sdk/provider/dist/index.d.ts` 搜索 `LanguageModelV4Content` 与 `LanguageModelV4FinishReason`，按实际字段名调整；不要用 `as any` 掩盖。

`packages/agent/src/tool.ts`:

```ts
import type { z } from 'zod';

export type ToolCategory = 'browser' | 'http' | 'db' | 'fixture' | 'profile' | 'requirements';

export interface ToolContext {
  signal: AbortSignal;
}

export interface AgentTool<I = any> {
  /** 只允许字母、数字、下划线、连字符（部分厂商不接受点号） */
  name: string;
  category: ToolCategory;
  description: string;
  input: z.ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<unknown>;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function defineTool<I>(t: AgentTool<I>): AgentTool<I> {
  if (!TOOL_NAME.test(t.name)) throw new Error(`工具名只能包含字母、数字、下划线和连字符：${t.name}`);
  return t;
}
```

`packages/agent/src/grants.ts`:

```ts
import type { AgentTool, ToolCategory } from './tool';

export type Stage = 'extract' | 'plan' | 'prepare' | 'execute' | 'review';

/**
 * 各阶段可授予的工具类别（防作弊硬约束）：
 * - plan 只能读条款和画像，拿不到任何读业务代码或操作系统的工具；
 * - execute 不授予夹具，代理不能自己造数绕过；
 * - review 不授予工具，只基于给定证据判定。
 */
export const STAGE_GRANTS: Record<Stage, readonly ToolCategory[]> = {
  extract: ['profile'],
  plan: ['profile', 'requirements'],
  prepare: ['fixture', 'browser', 'http', 'db', 'profile'],
  execute: ['browser', 'http', 'db', 'profile'],
  review: [],
};

export function grantTools(stage: Stage, tools: AgentTool[]): { granted: AgentTool[]; denied: AgentTool[] } {
  const allowed = new Set(STAGE_GRANTS[stage]);
  const granted: AgentTool[] = [];
  const denied: AgentTool[] = [];
  for (const t of tools) (allowed.has(t.category) ? granted : denied).push(t);
  return { granted, denied };
}
```

`packages/agent/src/index.ts`:

```ts
export * from './tool';
export * from './grants';
```

- [ ] **Step 5: 运行测试**

Run: `pnpm vitest run packages/agent && pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(agent): 假模型、工具定义与阶段授权"
```

---

### Task 11: agent —— 代理循环 runAgent

**Files:**
- Create: `packages/agent/src/loop.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/test/loop.test.ts`

**Interfaces:**
- Consumes: `BudgetTracker`（Task 7）、`callWithFallback`、`ModelCandidate`、`ResilienceOptions`（Task 8、9）、`AgentTool`、`grantTools`、`Stage`、`scriptedModel`（Task 10）
- Produces（计划 2 的执行/复核流程直接使用）:
  - `type BlockReason = 'budget' | 'invalid-output' | 'reported' | 'interrupted' | 'model-error'`
  - `interface ToolCallEvent { name: string; input: unknown; ok: boolean; output?: unknown; error?: string }`
  - `interface RunAgentOptions<O> { stage: Stage; models: ModelCandidate[]; system: string; messages: ModelMessage[]; tools: AgentTool[]; output: z.ZodType<O>; budget: BudgetTracker; signal?: AbortSignal; maxInvalidOutputs?: number; resilience?: ResilienceOptions; onUsage?: (ref: string, usage: { inputTokens?: number; outputTokens?: number }) => void; onToolCall?: (e: ToolCallEvent) => void }`
  - `type AgentResult<O> = { status: 'done'; output: O; steps: number; retried: boolean; messages: ModelMessage[] } | { status: 'blocked'; reason: BlockReason; detail: string; steps: number; retried: boolean; messages: ModelMessage[] }`
  - `runAgent<O>(opts: RunAgentOptions<O>): Promise<AgentResult<O>>`
  - 内置工具名常量：`FINISH_TOOL = 'finish'`、`REPORT_BLOCKED_TOOL = 'report_blocked'`

- [ ] **Step 1: 写失败的测试**

`packages/agent/test/loop.test.ts`:

```ts
import { BudgetTracker } from '@crosscheck/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, runAgent, type RunAgentOptions } from '../src/index';
import { scriptedModel, type ScriptStep } from '../src/testing/scripted-model';

const Output = z.object({ answer: z.string() });

const echo = defineTool({
  name: 'echo',
  category: 'profile',
  description: '原样返回',
  input: z.object({ x: z.number() }),
  execute: vi.fn(async (input: { x: number }) => ({ echoed: input.x })),
});

const fixture = defineTool({
  name: 'fixture_apply',
  category: 'fixture',
  description: '造数',
  input: z.object({ name: z.string() }),
  execute: vi.fn(async () => 'done'),
});

function opts(steps: ScriptStep[], over: Partial<RunAgentOptions<z.infer<typeof Output>>> = {}) {
  const model = scriptedModel(steps);
  return {
    model,
    options: {
      stage: 'execute',
      models: [{ ref: 'mock:primary', model }],
      system: '你是测试员',
      messages: [{ role: 'user', content: '开始' }],
      tools: [echo, fixture],
      output: Output,
      budget: new BudgetTracker({ steps: 10, tokens: 1_000_000, minutes: 10 }),
      resilience: { retries: 0, sleep: async () => {} },
      ...over,
    } satisfies RunAgentOptions<z.infer<typeof Output>>,
  };
}

const promptText = (model: ReturnType<typeof scriptedModel>, i: number) => JSON.stringify(model.doGenerateCalls[i]?.prompt);

describe('runAgent', () => {
  it('调用工具后提交合法结果', async () => {
    const events: unknown[] = [];
    const { model, options } = opts([
      { toolCalls: [{ name: 'echo', input: { x: 7 } }] },
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
    ]);
    const r = await runAgent({ ...options, onToolCall: (e) => events.push(e) });
    expect(r).toMatchObject({ status: 'done', output: { answer: 'ok' }, steps: 2, retried: false });
    expect(events[0]).toEqual({ name: 'echo', input: { x: 7 }, ok: true, output: { echoed: 7 } });
    expect(promptText(model, 1)).toContain('echoed');
  });

  it('执行阶段调用夹具工具会被拒绝，夹具不会执行', async () => {
    const { model, options } = opts([
      { toolCalls: [{ name: 'fixture_apply', input: { name: 'reset' } }] },
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
    ]);
    const r = await runAgent(options);
    expect(r.status).toBe('done');
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(promptText(model, 1)).toContain('未授予');
  });

  it('工具输入不合 schema 时把错误反馈给模型', async () => {
    const { model, options } = opts([
      { toolCalls: [{ name: 'echo', input: { x: 'NaN' } }] },
      { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] },
    ]);
    await runAgent(options);
    expect(promptText(model, 1)).toContain('输入不合法');
  });

  it('工具抛错时把错误反馈给模型', async () => {
    const boom = defineTool({
      name: 'boom',
      category: 'browser',
      description: '总是失败',
      input: z.object({}),
      execute: async () => {
        throw new Error('页面崩溃');
      },
    });
    const { model, options } = opts(
      [{ toolCalls: [{ name: 'boom', input: {} }] }, { toolCalls: [{ name: 'finish', input: { answer: 'x' } }] }],
      { tools: [boom] },
    );
    await runAgent(options);
    expect(promptText(model, 1)).toContain('页面崩溃');
  });

  it('结果连续 3 次不合格判为 BLOCKED', async () => {
    const bad = { toolCalls: [{ name: 'finish', input: { answer: 1 } }] };
    const { options } = opts([bad, bad, bad, { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    const r = await runAgent(options);
    expect(r).toMatchObject({ status: 'blocked', reason: 'invalid-output' });
  });

  it('只回复文本不调用工具也计为不合格，并提醒模型', async () => {
    const { model, options } = opts([{ text: '我做完了' }, { toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    const r = await runAgent(options);
    expect(r.status).toBe('done');
    expect(promptText(model, 1)).toContain('必须调用工具');
  });

  it('代理上报障碍', async () => {
    const { options } = opts([{ toolCalls: [{ name: 'report_blocked', input: { reason: '登录页 500' } }] }]);
    expect(await runAgent(options)).toMatchObject({ status: 'blocked', reason: 'reported', detail: '登录页 500' });
  });

  it('步数预算耗尽', async () => {
    const loop = { toolCalls: [{ name: 'echo', input: { x: 1 } }] };
    const { options } = opts([loop, loop, loop], {
      budget: new BudgetTracker({ steps: 2, tokens: 1_000_000, minutes: 10 }),
    });
    const r = await runAgent(options);
    expect(r).toMatchObject({ status: 'blocked', reason: 'budget', steps: 2 });
  });

  it('已中断时不调用模型', async () => {
    const ac = new AbortController();
    ac.abort();
    const { model, options } = opts([], { signal: ac.signal });
    expect(await runAgent(options)).toMatchObject({ status: 'blocked', reason: 'interrupted' });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('主模型失败时切换备用模型，并标记为发生过重试', async () => {
    const primary = scriptedModel([{ error: new Error('503') }, { error: new Error('503') }]);
    const backup = scriptedModel([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }]);
    const { options } = opts([], {
      models: [
        { ref: 'mock:primary', model: primary },
        { ref: 'mock:backup', model: backup },
      ],
      resilience: { retries: 1, sleep: async () => {} },
    });
    const r = await runAgent(options);
    expect(r).toMatchObject({ status: 'done', retried: true });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it('所有模型都失败时判为 model-error', async () => {
    const { options } = opts([{ error: new Error('401') }]);
    expect(await runAgent(options)).toMatchObject({ status: 'blocked', reason: 'model-error' });
  });

  it('上报每次调用的 token 用量', async () => {
    const onUsage = vi.fn();
    const { options } = opts([{ toolCalls: [{ name: 'finish', input: { answer: 'ok' } }] }], { onUsage });
    await runAgent(options);
    expect(onUsage).toHaveBeenCalledWith('mock:primary', expect.objectContaining({ inputTokens: 10, outputTokens: 5 }));
  });

  it('自定义工具不能与内置工具重名', async () => {
    const clash = defineTool({ name: 'finish', category: 'profile', description: '', input: z.object({}), execute: async () => 1 });
    const { options } = opts([], { tools: [clash] });
    await expect(runAgent(options)).rejects.toThrow(/内置工具/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/agent/test/loop.test.ts`
Expected: FAIL，`runAgent` 未导出。

- [ ] **Step 3: 实现**

`packages/agent/src/loop.ts`:

```ts
import type { BudgetTracker } from '@crosscheck/core';
import { callWithFallback, type ModelCandidate, type ResilienceOptions } from '@crosscheck/models';
import { generateText, jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { grantTools, type Stage } from './grants';
import type { AgentTool } from './tool';

export const FINISH_TOOL = 'finish';
export const REPORT_BLOCKED_TOOL = 'report_blocked';
const ReportBlockedInput = z.object({ reason: z.string().min(1) });

export type BlockReason = 'budget' | 'invalid-output' | 'reported' | 'interrupted' | 'model-error';

export interface ToolCallEvent {
  name: string;
  input: unknown;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface RunAgentOptions<O> {
  stage: Stage;
  /** 主模型在前，备用模型在后 */
  models: ModelCandidate[];
  system: string;
  messages: ModelMessage[];
  tools: AgentTool[];
  /** 最终结果的结构，代理通过 finish 工具提交 */
  output: z.ZodType<O>;
  budget: BudgetTracker;
  signal?: AbortSignal;
  /** 累计多少次不合格输出后判为 BLOCKED，默认 3 */
  maxInvalidOutputs?: number;
  resilience?: ResilienceOptions;
  onUsage?: (ref: string, usage: { inputTokens?: number; outputTokens?: number }) => void;
  /** 每次工具调用的回调，计划 2 用它记录轨迹 */
  onToolCall?: (e: ToolCallEvent) => void;
}

interface RunInfo {
  steps: number;
  retried: boolean;
  messages: ModelMessage[];
}

export type AgentResult<O> =
  | ({ status: 'done'; output: O } & RunInfo)
  | ({ status: 'blocked'; reason: BlockReason; detail: string } & RunInfo);

type ToolResultOutput = { type: 'json'; value: any } | { type: 'error-text'; value: string };

function toJsonValue(v: unknown): unknown {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

function schemaOf(s: z.ZodType) {
  // 只把 JSON Schema 交给 SDK，不让 SDK 校验；校验由我们用 zod 完成，便于把错误反馈给模型
  return jsonSchema(z.toJSONSchema(s, { io: 'input' }) as Parameters<typeof jsonSchema>[0]);
}

function buildSdkTools(granted: AgentTool[], output: z.ZodType): ToolSet {
  const set: ToolSet = {};
  for (const t of granted) set[t.name] = tool({ description: t.description, inputSchema: schemaOf(t.input) });
  set[FINISH_TOOL] = tool({ description: '提交最终结果。参数必须完全符合给定结构。', inputSchema: schemaOf(output) });
  set[REPORT_BLOCKED_TOOL] = tool({
    description: '遇到无法自行解决的障碍时调用并说明原因。不要尝试绕过障碍。',
    inputSchema: schemaOf(ReportBlockedInput),
  });
  return set;
}

/**
 * 自研代理循环：每轮调用一次模型，由我们执行工具并校验输入输出。
 * 硬约束：只暴露本阶段授予的工具；必须通过 finish 提交合法结果；预算耗尽或中断即停止。
 */
export async function runAgent<O>(opts: RunAgentOptions<O>): Promise<AgentResult<O>> {
  const { stage, models, system, output, budget, signal, maxInvalidOutputs = 3, resilience, onUsage, onToolCall } = opts;

  for (const t of opts.tools) {
    if (t.name === FINISH_TOOL || t.name === REPORT_BLOCKED_TOOL) throw new Error(`工具名与内置工具冲突：${t.name}`);
  }
  const { granted } = grantTools(stage, opts.tools);
  const toolMap = new Map(granted.map((t) => [t.name, t]));
  const sdkTools = buildSdkTools(granted, output);
  const messages: ModelMessage[] = [...opts.messages];
  const abortSignal = signal ?? new AbortController().signal;

  let steps = 0;
  let retried = false;
  let invalid = 0;
  const info = (): RunInfo => ({ steps, retried, messages });
  const blocked = (reason: BlockReason, detail: string): AgentResult<O> => ({ status: 'blocked', reason, detail, ...info() });

  while (true) {
    if (abortSignal.aborted) return blocked('interrupted', '执行被中断');
    const exhausted = budget.exhausted();
    if (exhausted) return blocked('budget', exhausted);

    let res: Awaited<ReturnType<typeof generateText>>;
    let ref: string;
    try {
      const r = await callWithFallback(
        models,
        (model) => generateText({ model, system, messages, tools: sdkTools, toolChoice: 'required', maxRetries: 0, abortSignal }),
        resilience,
      );
      res = r.value;
      ref = r.ref;
      if (r.attempts > 1) retried = true;
    } catch (err) {
      if (abortSignal.aborted) return blocked('interrupted', '执行被中断');
      return blocked('model-error', err instanceof Error ? err.message : String(err));
    }

    steps++;
    budget.recordStep();
    budget.recordTokens((res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0));
    onUsage?.(ref, { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens });
    messages.push(...res.responseMessages);

    if (res.toolCalls.length === 0) {
      invalid++;
      if (invalid >= maxInvalidOutputs) return blocked('invalid-output', `连续 ${invalid} 次没有按要求调用工具`);
      messages.push({
        role: 'user',
        content: `你必须调用工具：完成时调用 ${FINISH_TOOL} 提交结果，无法继续时调用 ${REPORT_BLOCKED_TOOL}。`,
      });
      continue;
    }

    const results: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; output: ToolResultOutput }> = [];
    let finished: { value: O } | undefined;
    let reported: string | undefined;

    for (const call of res.toolCalls) {
      const reply = (out: ToolResultOutput) =>
        results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: out });

      if (call.toolName === FINISH_TOOL) {
        const parsed = output.safeParse(call.input);
        if (parsed.success) {
          finished = { value: parsed.data };
          reply({ type: 'json', value: '已收到' });
        } else {
          invalid++;
          reply({ type: 'error-text', value: `结果不合格，请修正后重新调用 ${FINISH_TOOL}：\n${z.prettifyError(parsed.error)}` });
        }
        continue;
      }

      if (call.toolName === REPORT_BLOCKED_TOOL) {
        const parsed = ReportBlockedInput.safeParse(call.input);
        reported = parsed.success ? parsed.data.reason : '代理上报障碍但未说明原因';
        reply({ type: 'json', value: '已记录' });
        continue;
      }

      const t = toolMap.get(call.toolName);
      if (!t) {
        const error = `工具 ${call.toolName} 在 ${stage} 阶段未授予`;
        onToolCall?.({ name: call.toolName, input: call.input, ok: false, error });
        reply({ type: 'error-text', value: error });
        continue;
      }
      const parsed = t.input.safeParse(call.input);
      if (!parsed.success) {
        const error = `工具 ${t.name} 的输入不合法：\n${z.prettifyError(parsed.error)}`;
        onToolCall?.({ name: t.name, input: call.input, ok: false, error });
        reply({ type: 'error-text', value: error });
        continue;
      }
      try {
        const out = toJsonValue(await t.execute(parsed.data, { signal: abortSignal }));
        onToolCall?.({ name: t.name, input: parsed.data, ok: true, output: out });
        reply({ type: 'json', value: out });
      } catch (err) {
        const error = `工具 ${t.name} 执行失败：${err instanceof Error ? err.message : String(err)}`;
        onToolCall?.({ name: t.name, input: parsed.data, ok: false, error });
        reply({ type: 'error-text', value: error });
      }
    }

    messages.push({ role: 'tool', content: results });

    if (reported !== undefined) return blocked('reported', reported);
    if (finished) return { status: 'done', output: finished.value, ...info() };
    if (invalid >= maxInvalidOutputs) return blocked('invalid-output', `结果连续 ${invalid} 次不合格`);
  }
}
```

`packages/agent/src/index.ts` 追加：

```ts
export * from './loop';
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run packages/agent && pnpm typecheck`
Expected: PASS。

排错提示（不要靠放宽断言解决）：
- 如果 tsc 报 `res.responseMessages` 不存在，查看 `node_modules/ai/dist/index.d.ts` 中 `GenerateTextResult` 的字段名（v7 文档为 `responseMessages`；旧版本为 `response.messages`），按实际字段改。
- 如果 `messages.push({ role: 'tool', content: results })` 类型不符，从 `ai` 导入 `ToolResultPart` 类型替换本地类型。
- 如果“结果连续 3 次不合格”测试中 SDK 自己拦截了 `{ answer: 1 }`（`res.toolCalls` 为空或带 `invalid: true`），说明 SDK 仍在校验 JSON Schema；确认 `schemaOf` 传入的是 `jsonSchema(...)` 且未提供 `validate`。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(agent): 带工具授权、预算与结构化输出校验的代理循环"
```

---

### Task 12: 全仓验证

**Files:**
- Create: `README.md`（简短：项目目标、包结构、`pnpm test` / `pnpm typecheck`，指向规格与计划）

- [ ] **Step 1: 全量测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 所有测试 PASS，tsc 无输出。

- [ ] **Step 2: 检查依赖方向**

Run:
```bash
grep -rn "@crosscheck/" packages/core/src || echo "core 无内部依赖"
grep -rn "@crosscheck/agent" packages/models/src || echo "models 不依赖 agent"
```
Expected: 两条都输出“无/不依赖”的提示。

- [ ] **Step 3: 写 README 并提交**

`README.md`:

```markdown
# Crosscheck

通用的 AI 自动化验收测试 CLI：判定标准来自经人确认的需求条款，判定必须引用工具层自动采集的证据，执行与复核由不同模型独立完成。

- 设计说明：`docs/specs/2026-11-12-v1-design.md`
- 实施计划：`docs/superpowers/plans/`

## 开发

需要 Node.js ≥ 20 与 pnpm 9。

    pnpm install
    pnpm test        # 单元测试（使用假模型，不消耗 token）
    pnpm typecheck

## 包

| 包 | 职责 |
|---|---|
| `@crosscheck/core` | 工件 schema 与存储、确认机制、工作流门禁、守卫、合议、脱敏、预算 |
| `@crosscheck/models` | 按角色解析模型、重试与备用模型、用量统计 |
| `@crosscheck/agent` | 代理循环、工具授权、假模型 |
```

```bash
git add -A
git commit -m "docs: README"
```

---

## 规格覆盖自查（计划 1 范围）

| 规格条目 | 任务 |
|---|---|
| §3 TS/ESM、pnpm monorepo、zod、vitest、AI SDK v7 | 1、8、10 |
| §5.1 条款 / §5.2 用例格式 | 1 |
| §5 工件目录、只写 `.crosscheck/` | 2 |
| §5.3 哈希确认、修改后失效 | 3 |
| §7 阶段顺序强制（画像→条款→用例→执行） | 4（CLI 调用在计划 2/3） |
| §8.4 判定必须引用存在且类型匹配的证据 | 5 |
| §8.6 合议表、最严重状态汇总 | 5 |
| §11 退出码 0/1/2 | 5（3 由 CLI 在计划 2 处理） |
| §8.1 白名单/禁止规则、数据库只读 | 6 |
| §12 脱敏 | 7 |
| §8.1 步数/token/时长预算 | 7、11 |
| §9 provider:model、内置厂商、openai-compatible、密钥只读环境变量、同厂商警告 | 8 |
| §12 指数退避、备用模型；§4 token/费用统计 | 9 |
| §8.1 工具按阶段授予、执行阶段无夹具；§7 plan 阶段无读代码工具 | 10、11 |
| §12 结构化输出校验最多 3 次；代理只能上报 BLOCKED | 11 |
| §8 附加标签“低可靠”所需的重试信号 | 11（`retried`） |
| §13.2 假模型 | 10 |

留给后续计划：上下文压缩、证据采集、轨迹格式、盲审输入构造、断点续跑、Ctrl+C 处理（计划 2）；画像文件 schema 细节（environments/auth/api-catalog/pages/data-model/fixtures）、发现、TUI（计划 3）；靶场与评测（计划 4）。
