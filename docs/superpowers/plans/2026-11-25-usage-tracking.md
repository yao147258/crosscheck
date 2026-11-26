# 统一用量统计实施计划

> **执行代理必需技能：** 使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐任务按复选框执行。

**目标：** 为第一阶段的聊天、生成命令和 run 建立项目级、逐次模型请求的用量账本及会话 `/usage` 展示。

**架构：** 在 `@crosscheck/models` 实现项目定位、事件构造、持久化和聚合；在三个真实 `generateText` 调用边界记录回执，业务路径只透传不自行重复记账。CLI 持有本进程临时会话 ID，斜杠命令透传项目与会话关联；Ink 页头按操作结束刷新。原有 runner 审计、预算和结果不变。

**技术栈：** Node.js >=22.12、TypeScript、pnpm 9.15.9、Vitest、AI SDK、React/Ink。

**设计依据：** `docs/superpowers/specs/2026-11-25-session-usage-context-design.md`，只实施第 42–48 行账本及其相关验收。

## 全局约束

- 本计划的执行也不得自动提交；用户另行明确要求后才可提交。不要改现有审核、工具权限、证据门禁、run 结果及恢复行为。
- 暂不实现持久化会话、`/sessions`、`/resume`、聊天上下文压缩、新的聊天快照规则、模型窗口验证或能力回退；聊天仍保留现有 20 条限制。
- 事件不得保存提示词、聊天正文、工具输出、密钥、异常正文或 provider URL；历史 run 不回填、不导入账本。
- 每个已发起的真实请求一条记录；准备失败或请求前取消不记；失败/取消无回执是未知，不能记零。账本失败不遮盖模型结果、不触发模型重试、不改变 runner 严格宿主审计错误语义。
- 用量按实际配置解析后的 provider 名和无窗口后缀 model ID 分组；价格、费用为调用时快照，费用为估算，不是账单。SDK 未提供实际服务端 model ID 时不能声称知道服务端的别名重定向。
- 单次 CLI 归项目不归会话；交互会话归当前临时 ID；跨项目斜杠命令归目标项目但仍关联当前 ID。`/clear` 换 ID，不删除项目账本。

## 文件结构与接口

- 新建 `packages/models/src/usage-ledger.ts`：事件类型、定位、写入、读取和聚合；从 `packages/models/src/index.ts` 导出。
- 修改 `packages/models/src/usage.ts`：新增精确引用优先、去窗口后缀回退的价格查找及保守计价；保持旧 `UsageMeter.add` 行为兼容。
- 修改 `packages/agent/src/loop.ts`、`summarizer.ts`、`subagent.ts`：独立非致命账本通知；正常、摘要、子代理及取消都从真实调用边界上报。
- 修改 discovery 三个入口、requirements、planner 的 options 与 CLI `init.ts`、`profile.ts`、`reqs.ts`、`plan.ts`：逐层传递同一个通知器。
- 修改 `packages/runner/src/run-suite.ts`、`run-case.ts`、`packages/cli/src/run.ts`：保留原 `onModelAttempt`，另接账本通知，按 prepare/execute 使用 executor，review 使用 reviewer。
- 修改 `packages/cli/src/context.ts`、`session.ts`、`args.ts`：构造账本、临时 ID、命令查询和警告；修改 `packages/tui/src/session.tsx`、`header.tsx` 展示及刷新。
- 测试分别放 `packages/models/test/usage-ledger.test.ts`、现有 agent、CLI、runner、TUI 测试目录；更新 `README.md` 的用量说明。

### 公共契约

```ts
// packages/models/src/usage-ledger.ts
export type UsageNumbers = {
  inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
};
export type UsagePrice = {
  inputPerMTok: number; outputPerMTok: number;
  cacheReadPerMTok?: number; cacheWritePerMTok?: number;
};
export type UsageEvent = {
  version: 1; id: string; time: string; projectKey: string;
  sessionId: string | null; command: 'chat' | 'init' | 'profile' | 'reqs' | 'plan' | 'run';
  purpose: 'request' | 'compact'; role: 'extractor' | 'planner' | 'executor' | 'reviewer';
  configuredRef: string; provider: string; modelId: string;
  status: 'success' | 'error' | 'cancelled'; usage: UsageNumbers;
  price: UsagePrice | null; cost: number | null;
};
export type UsageAttempt = {
  ref: string; status: UsageEvent['status']; purpose: UsageEvent['purpose'];
  usage: Partial<Record<keyof UsageNumbers, number>> | null;
};
export type UsageObserver = (attempt: UsageAttempt) => void | Promise<void>;
export interface UsageContext {
  sessionId: string | null;
  warn: (message: string) => void;
}
export type UsageBucket = UsageNumbers & { cost: number; calls: number; unknownCalls: number };
export type UsageReport = {
  total: UsageBucket; byCommand: Record<string, UsageBucket>;
  byRole: Record<string, UsageBucket>; byModel: Record<string, UsageBucket>;
  incomplete: boolean; diagnostics: string[];
};
export function createUsageObserver(options: {
  project: string; home?: string; sessionId: string | null;
  command: UsageEvent['command']; role: UsageEvent['role'];
  pricing: Record<string, UsagePrice>; warn: (message: string) => void;
}): UsageObserver;
export function readUsage(options: {
  project: string; home?: string; sessionId?: string;
}): Promise<UsageReport>;
```

聚合的 `UsageBucket` 中四项数值是**已知部分之和**（空集为 0），`unknownCalls` 表示至少一个 token、价格或费用未知的调用数；缺失缓存计数也是未知，不能把它直接当作真实零。即使全部字段已知也不能据此保证服务商账单完全一致。

---

### 任务 1：项目位置、事件与保守价格

**文件：** 新建 `packages/models/src/usage-ledger.ts`、`packages/models/test/usage-ledger.test.ts`；修改 `packages/models/src/usage.ts`、`packages/models/src/index.ts`。

**接口：** 消费 `parseModelRef(ref)` 和 `Config['pricing']`；产出上面的 `UsageEvent`、`createUsageObserver`、`readUsage`，另导出 `projectUsageLocation(project: string, home?: string): Promise<{ projectKey: string; directory: string }>` 和 `makeUsageEvent(options: Parameters<typeof createUsageObserver>[0], projectKey: string, attempt: UsageAttempt): UsageEvent`。

- [ ] **步骤 1：写价格与路径失败测试。** 在新测试中使用 `mkdtemp` 和真实目录，覆盖以下断言；`makeUsageEvent` 的随机 ID 和时间只校验格式。

```ts
import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeUsageEvent, projectUsageLocation } from '../src/usage-ledger';

const price = { inputPerMTok: 10, outputPerMTok: 20, cacheReadPerMTok: 2, cacheWritePerMTok: 5 };
const options = { project: '.', sessionId: null, command: 'chat' as const, role: 'planner' as const, pricing: { 'p:m': price, 'p:m[1M]': { ...price, inputPerMTok: 11 } }, warn: () => {} };
describe('账本事件', () => {
  it('保留配置引用，按去后缀模型归组，价格精确优先且不重复计算缓存', () => {
    const e = makeUsageEvent(options, 'key', { ref: 'p:m[1M]', status: 'success', purpose: 'request', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 10 } });
    expect([e.configuredRef, e.provider, e.modelId]).toEqual(['p:m[1M]', 'p', 'm']);
    expect(e.price?.inputPerMTok).toBe(11);
    expect(e.cost).toBeCloseTo((70 * 11 + 20 * 2 + 10 * 5 + 10 * 20) / 1e6);
  });
  it('缺缓存回执或价格时费用未知，而不是零；失败全未知', () => {
    const a = makeUsageEvent(options, 'key', { ref: 'p:m[2M]', status: 'success', purpose: 'request', usage: { inputTokens: 0, outputTokens: 0 } });
    expect(a.price).toEqual(price); expect(a.cost).toBeNull(); expect(a.usage.cacheReadTokens).toBeNull();
    const b = makeUsageEvent(options, 'key', { ref: 'p:other', status: 'error', purpose: 'request', usage: null });
    expect(b.price).toBeNull(); expect(b.cost).toBeNull(); expect(b.usage.inputTokens).toBeNull();
  });
  it('真实路径隔离项目，无法解析不回退成另一个项目', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'usage-home-'));
    const a = path.join(home, 'a'), b = path.join(home, 'b'); await mkdir(a); await mkdir(b);
    expect((await projectUsageLocation(a, home)).projectKey).not.toBe((await projectUsageLocation(b, home)).projectKey);
    expect((await projectUsageLocation(path.join(a, '..', 'a'), home)).projectKey).toBe((await projectUsageLocation(await realpath(a), home)).projectKey);
    await expect(projectUsageLocation(path.join(home, 'missing'), home)).rejects.toThrow();
    if (process.platform !== 'win32') { const link = path.join(home, 'link'); await symlink(a, link); expect((await projectUsageLocation(link, home)).projectKey).toBe((await projectUsageLocation(a, home)).projectKey); }
  });
});
```

补充测试：负数、非整数、非有限数、缓存读写之和大于输入均使费用未知；明确 0 回执仍为已知。测试无后缀价格回退与精确价格竞争，已有 `UsageMeter` 测试保持不变。

- [ ] **步骤 2：执行红灯。** `pnpm exec vitest run packages/models/test/usage-ledger.test.ts`；预期因模块/导出不存在失败。

- [ ] **步骤 3：实现路径和价格。** `realpath(path.resolve(project))` 后 `path.normalize`，各平台均保留操作系统返回的实际路径大小写，避免 Windows 大小写敏感目录中的不同项目混计；对规范路径 UTF-8 用 `createHash('sha256').update(canonical).digest('hex')`。目录为 `path.join(home ?? os.homedir(), '.crosscheck', 'projects', projectKey, 'usage')`。`realpath` 抛错不使用字符串兜底。事件 `id=randomUUID()`、`time=new Date().toISOString()`；价格选 `pricing[ref] ?? pricing[provider + ':' + modelId] ?? null` 并复制对象，拒绝不合法数字。`usage` 四项只接收非负安全整数，否则对应 `null`；状态非成功且无回执时全 `null`。仅四项和价格均有效且缓存和不超输入时计算 `(input-read-write)*inputPrice + read*readPrice + write*writePrice + output*outputPrice` 再除 1,000,000；缓存单价缺省回退输入单价。禁止使用 `UsageMeter.add` 聚合新账本。

- [ ] **步骤 4：执行绿灯。** `pnpm exec vitest run packages/models/test/usage-ledger.test.ts packages/models/test/task8-models.test.ts`；预期全部通过。

### 任务 2：并发持久化、损坏诊断及汇总

**文件：** 修改 `packages/models/src/usage-ledger.ts`、`packages/models/test/usage-ledger.test.ts`。

**接口：** 任务 1 的 `createUsageObserver` 与 `readUsage`；读取按可选 `sessionId` 过滤，先验证文件再聚合。

- [ ] **步骤 1：写失败测试。** 以临时 `home`、项目为夹具，创建两个 observer 并用 `Promise.all` 写入 100 个唯一事件；验证 `readUsage` 的 `total.calls === 100`、各分组和会话过滤。另在 usage 目录写 `broken.json`（截断 JSON）、合法 JSON 但缺字段/版本错误、半成品 `.tmp`，断言 `incomplete === true` 且 diagnostics 不为空，其他合法事件仍可读。用 `home` 指向普通文件模拟写入失败，断言 observer 不拒绝、`warn` 被调用且不泄露错误字符串。用空目录断言零调用和 `incomplete === false`。

```ts
const obs = createUsageObserver({ ...options, project, home, sessionId: 'session-a', warn });
await Promise.all(Array.from({ length: 100 }, () => obs({ ref: 'p:m', status: 'success', purpose: 'request', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } })));
const report = await readUsage({ project, home, sessionId: 'session-a' });
expect(report.total.calls).toBe(100);
expect(report.total.inputTokens).toBe(300);
expect(report.byModel['p:m']?.calls).toBe(100);
```

- [ ] **步骤 2：执行红灯。** `pnpm exec vitest run packages/models/test/usage-ledger.test.ts`；预期持久化和汇总断言失败。

- [ ] **步骤 3：实现每事件独立文件提交。** 目录 `mkdir({recursive:true, mode:0o700})`；创建 `<id>.tmp`，`open(...,'wx',0o600)`，一次写完整 JSON，关闭后 rename 为 `<id>.json`。禁止所有进程向一个 JSONL 并发追加；UUID 排除文件名竞争，rename 前崩溃留下 `.tmp`，读取时报告不完整。验证所有字段、枚举、UUID、时间、项目哈希及安全整数；错误文件不视为空且跳过该文件，不输出其内容。`ENOENT` 的账本目录表示空账本，其他读取错误返回明确不完整报告。每种 token 分别对非 null 值求和；只要一个字段或 cost 为 null 就增加该事件的 `unknownCalls`；汇总命令/角色/`${provider}:${modelId}`。

- [ ] **步骤 4：隔离写入错误。** `createUsageObserver` 在每次实际调用完成后 `try { await ... } catch { options.warn('用量记录写入失败，本次统计不完整'); }`；连 `warn` 自身异常也吞掉。每次独立尝试写入；不重试 provider。读写失败警告不得带路径或原始异常。写失败既可能无缺口标记，也可能留下 `.tmp`，不保证将来的查询能发现缺失。

- [ ] **步骤 5：执行绿灯。** `pnpm exec vitest run packages/models/test/usage-ledger.test.ts`；再运行 `pnpm typecheck`；预期通过。并发测试另启动两个 Node 子进程各写多个事件，验证跨进程文件数、完整 JSON 和唯一 ID，不能仅依赖 Promise 并发。

### 任务 3：代理和摘要的真实调用边界

**文件：** 修改 `packages/agent/src/loop.ts`、`summarizer.ts`、`subagent.ts`；修改 `packages/agent/test/loop.test.ts`、`summarizer.test.ts`、`subagent.test.ts`。

**接口：** 在 `RunAgentOptions`、`SummarizerHooks`、`ParentContext` 增加 `usageObserver?: UsageObserver`；对外消费任务 1 的 observer；原 `onModelAttempt` 不变且仍可抛出宿主错误。

- [ ] **步骤 1：写失败测试。** 用现有 `scripted-model.ts` 和测试中的模型夹具，分别构造一次成功、两次重试后备用模型成功、请求中取消、压缩成功/失败/取消、派生子代理的请求。收集 observer 数组并断言每次真实请求一个条目，备用模型 `ref` 正确，`purpose` 区分 `request` 与 `compact`，无回执 `usage === null`，取消为 `cancelled`。确认准备/预算失败及请求前 abort 没有事件。让 observer 抛错时模型结果和既有宿主审计不改变；让 `onModelAttempt` 抛错时仍按现有宿主故障测试阻断。

```ts
const attempts: UsageAttempt[] = [];
const usageObserver: UsageObserver = async (attempt) => { attempts.push(attempt); };
// 在现有 runAgent 测试的真实模型调用夹具上添加 usageObserver。
expect(attempts.map(({ ref, status, purpose }) => ({ ref, status, purpose }))).toEqual([
  { ref: 'p:primary', status: 'error', purpose: 'request' },
  { ref: 'p:backup', status: 'success', purpose: 'request' },
]);
```

- [ ] **步骤 2：执行红灯。** `pnpm exec vitest run packages/agent/test/loop.test.ts packages/agent/test/summarizer.test.ts packages/agent/test/subagent.test.ts`；预期新增断言失败。

- [ ] **步骤 3：在真实调用处接线。** 在 `generateText` 的 try/catch 内仅捕获 provider 错误，发送事件必须放在 provider catch 之外或使用不会抛出的 `notify` 包装，避免 observer 错误被当作 provider 失败触发重试。`loop.ts` 已有 `usageOf` 提取四项；原 `record`、`onUsage` 和预算计算不动。`summarizer.ts` 要在 `if (signal.aborted) throw signal.reason` **之前**发送取消事件，并补齐 `inputTokenDetails.cacheReadTokens/cacheWriteTokens`；摘要解析失败仍是已成功调用。`subagent.ts` 从 parent 传递同一个 `usageObserver`；父子只在各自 `generateText` 通知，不在汇总时再通知。

```ts
const notify = async (observer: UsageObserver | undefined, attempt: UsageAttempt) => {
  try { await observer?.(attempt); } catch { /* 用量观察者不得改变模型调用 */ }
};
// provider catch 中：await notify(opts.usageObserver, { ref, purpose: 'request', status: genSignal.aborted ? 'cancelled' : 'error', usage: null });
// provider 成功后：await notify(opts.usageObserver, { ref, purpose: 'request', status: 'success', usage: usageOf(value.usage) });
```

将 `notify` 与 `usageOf` 放在 agent 内可复用的单一文件并从 loop/summarizer 引入；使用 `@crosscheck/models` 的导出类型。原摘要的 `onAttempt` 成功/失败语义不变，取消只新增账本通知，不能让新账本更改现有可靠性统计。

- [ ] **步骤 4：执行绿灯。** 运行步骤 2 的命令及 `pnpm typecheck`；预期全部通过。

### 任务 4：生成命令和 runner 透传、去重

**文件：** 修改 `packages/discovery/src/{explore-project,synthesize-notes,synthesize-profile}.ts`、`packages/requirements/src/extract.ts`、`packages/planner/src/generate-cases.ts`、`packages/cli/src/{context,init,profile,reqs,plan,run}.ts`、`packages/runner/src/{run-suite,run-case}.ts`；扩展相应测试。

**接口：** 每个生成 options 接受 `usageObserver?: UsageObserver` 并传给每个 `runAgent`；`CommandDependencies` 增加 `usageContext?: UsageContext`。`RunSuiteOptions` 和 `CaseHostOptions` 增加 `usageContext?: UsageContext`，直接调用时缺省 `sessionId: null`。runner 分阶段分别构造 observer，`prepare/execute` 为 executor，`review` 为 reviewer。

- [ ] **步骤 1：写失败测试。** 在现有 CLI 测试夹具分别运行 `init`、`profile`（含探索和多次合成）、`reqs`、`plan`，并断言真实调用数量与读出的事件数量相等，command/role 分别是 `init/extractor`、`profile/extractor`、`reqs/extractor`、`plan/planner`。重试、摘要与子代理也单独计数。通过 `usageContext: { sessionId: 's1', warn }` 执行一次会话式调用，再用不带 context 的直接命令验证 `sessionId === null`。在 runner 现有端到端夹具确认 prepare、execute、review 用不同角色，账本条数恰等于各次真实 provider 调用数，而不是 run 结果再加一遍。

```ts
// 嵌入已有 runner 成功测试，在执行前为临时项目和 home 指定 usageContext。
const report = await readUsage({ project: projectDir, home, sessionId: 's1' });
expect(report.byCommand.run?.calls).toBe(providerCalls.length);
expect(report.byRole.executor?.calls).toBe(executorCalls.length);
expect(report.byRole.reviewer?.calls).toBe(reviewerCalls.length);
```

- [ ] **步骤 2：执行红灯。** `pnpm exec vitest run packages/cli/test/init.test.ts packages/cli/test/profile.test.ts packages/cli/test/reqs-plan.test.ts packages/runner/test/task9.test.ts`；预期新事件断言失败。

- [ ] **步骤 3：逐层透传。** 五个业务 options 均增加 `usageObserver?: UsageObserver` 并在 `runAgent({...})` 中原样传入；`profileCommand` 对 `exploreProject` 和 `synthesizeProfile` 使用同一 observer，后者在每个循环都传入。每个 CLI 命令在 `loadModelContext` 得到 config 后创建 `createUsageObserver({ project: args.project, home: deps.userConfigHome, sessionId: deps.usageContext?.sessionId ?? null, command: 'init' /* 对应命令 */, role: 'extractor' /* plan 为 planner */, pricing: config.pricing, warn: deps.usageContext?.warn ?? log })`。生成命令不扫描返回值的 `modelAttempts` 再导入。

- [ ] **步骤 4：runner 保持两条用途不同的通知。** `runSuite` 将 `usageContext` 和 `userConfigHome` 传给 `executeCase`。在 `run-case.ts` 的三个 `runAgent` 调用和 `prepareCase` 的 fallback 内分别指定相应 `usageObserver`；价格取 `input.config.pricing`，项目由 `runCommand` 显式传入新增的 `RunSuiteOptions.usageProject: string`，再由 `runSuite` 传给 `CaseHostOptions.usageProject`；`ArtifactStore.root` 指向 `.crosscheck` 而非项目根，不从它反推项目。对外部直接调用 `runSuite`，将 `usageProject` 定义为可选，缺失时警告并跳过账本，不影响原有运行行为。原 `onModelAttempt` 继续维护 reliability/modelLog/旧 usage，不在它里面调用账本，也不从 `RunResult` 导入。`runCommand` 的 dependencies 类型改成能透传新 context，不改变原退出码。

- [ ] **步骤 5：写失败隔离回归。** 为生成命令和 runner 注入写入失败的 `home` 或注入 observer，断言模型结果、runner 审核结论及既有审计不变，用户收到无秘密的警告；确保 provider 请求次数未增加。分别验证现有 `onModelAttempt` 故障依然阻断。

- [ ] **步骤 6：执行绿灯。** 运行步骤 2 的命令、`pnpm exec vitest run packages/agent/test/subagent.test.ts` 和 `pnpm typecheck`；预期通过。

### 任务 5：聊天、临时会话 ID 与 `/usage`

**文件：** 修改 `packages/cli/src/session.ts`、`args.ts`、`context.ts`，`packages/tui/src/session.tsx`、`header.tsx`；修改 `packages/cli/test/session.test.ts` 和现有 TUI 会话测试。

**接口：** `createSlashDispatcher(deps, session: { currentId: string; project: string })`；`chatReply` 使用 `deps.usageContext`；`RunSessionOptions` 新增 `resetSession: () => void`、`loadSessionUsage: () => Promise<string>`。`/usage` 和 `/usage --session [ID]`：不带参数查当前项目，`--session` 单独使用查当前 ID，给 ID 查指定 ID；其他参数返回退出码 2。ID 仅接受 UUID，查询项目固定为会话启动项目。

- [ ] **步骤 1：写失败测试。** 通过 `chatReply` 的现有 mock 模型构造失败、重试、备用成功与取消，断言每次请求一条账本事件、成功回执四字段、planner/chat 和临时会话 ID；让写入失败并断言回复保留且出现警告。通过 `createSlashDispatcher` 验证 `/usage`、`/usage --session`、`/usage --session <uuid>`、非法参数，报告含项目/会话范围、输入/输出/缓存已知部分、费用估算、未知调用数、命令/角色/模型分组、损坏诊断。通过 TUI 测试执行聊天、斜杠命令、`/clear`，断言页头刷新且新 ID 为零、旧项目累计不变；调用跨项目 `/init --project ...` 时事件归目标项目，当前项目查询不混入。

```ts
const state = { currentId: randomUUID(), project };
const dispatch = createSlashDispatcher(deps, state);
const result = await dispatch(['usage', '--session'], new AbortController().signal);
expect(result.kind).toBe('log');
if (result.kind === 'log') expect(result.lines.join('\n')).toContain('未知调用');
```

- [ ] **步骤 2：执行红灯。** `pnpm exec vitest run packages/cli/test/session.test.ts` 加上 `packages/tui/test` 中实际的会话测试文件；预期新命令和事件断言失败。

- [ ] **步骤 3：聊天在真实边界记账。** `sessionCommand` 创建 `{ currentId: randomUUID(), project: args.project }`；每次 chat 或 slash 启动时以当前 ID 创建 `usageContext`。`chatReply` 在 `callWithFallback` 的 callback 中、`generateText` 的 try/catch 旁分别向 `createUsageObserver` 通知 `request` 的 success/error/cancelled；成功在返回 `response.text` 前读取四项 `response.usage`；catch 中仅记录无回执并保留原脱敏诊断和原异常。不要在外层 fallback catch 或最终结果重复记账。聊天警告通过当前操作 `onProgress` 送 UI，直接调用用安全的 `console.warn` 或显式 warning callback。

- [ ] **步骤 4：斜杠与刷新。** 在命令列表和 `HELP` 加 `/usage`；dispatcher 直接解析查询而不是交给 `parseArgs`。普通命令调用 `cliMain(tokens, { dependencies: { ...deps, usageContext: { sessionId: session.currentId, warn: line => onProgress?.(line) } }, ... })`，目标项目仍由 `parseArgs` 的 `--project` 决定。`/clear` 返回 kind `clear` 后，由 `SessionApp` 调用同步 `resetSession()` 再清历史并刷新；绝不在返回 clear 前换 ID，否则取消时状态不一致。每次 chat/slash settle 后 await `loadSessionUsage()` 并 `setState`，避免页头异步过期；查询失败显示“统计不完整”而非抛到业务结果。`SessionHeader` 增加可选用量字符串，窄屏 truncate；显示当前 ID 以支持指定会话查询。查询必须在事件写入 await 后进行。

- [ ] **步骤 5：格式化。** 使用固定顺序总计、命令、角色、模型；显示文案 `已知输入/输出/缓存读/缓存写`、`已知费用估算`、`未知调用 N`，`incomplete` 或 `unknownCalls > 0` 时显示 `统计不完整`；不要把已知部分标成完整总额。`/usage` 结果不得进入聊天模型 history，沿用现有斜杠命令路径。

- [ ] **步骤 6：执行绿灯。** 执行步骤 2 的命令及 `pnpm typecheck`；预期通过。

### 任务 6：验收矩阵和用户说明

**文件：** 修改 `README.md` 及前述测试；不创建会话持久化文件。

**接口：** 消费完整的 `readUsage` 和 `/usage`；不新增运行时接口。

- [ ] **步骤 1：补齐端到端验收测试。** 复用真实 CLI 测试中的隔离项目、脚本模型与 `userConfigHome`；按以下矩阵断言。

```ts
expect(events.filter(e => e.command === 'chat')).toHaveLength(chatProviderCalls);
expect(events.filter(e => e.command === 'profile')).toHaveLength(profileProviderCalls);
expect(events.filter(e => e.command === 'run')).toHaveLength(runProviderCalls);
expect(new Set(events.map(e => e.id)).size).toBe(events.length);
expect(JSON.stringify(events)).not.toContain('测试专用密钥或提示词');
```

加入直接与会话两类调用、备用/重试、摘要取消、真实回执缺字段、未定价、写入失败、跨进程写入、损坏文件及 `/clear`；检查用例运行结果读取或 `run --resume` 不会回填已完成旧用例。使用已有测试数据而不是访问真实 provider 或网络。

- [ ] **步骤 2：更新 README。** 写明账本路径 `~/.crosscheck/projects/<规范项目路径 SHA-256>/usage/`、项目规范化（`realpath`；保留真实路径大小写；路径不可解析时不写并警告）、符号链接及路径别名的局限，文件权限 `0700/0600` 在 Windows 不等价 ACL，提示用户自行限制用户目录 ACL；哈希不是加密。说明不保存模型正文但模型名等元数据可能敏感；已有 `chat-requests.jsonl` 仍独立存在。说明 `/usage` 参数、费用估算、未知计数、损坏警告、启用前不回填、写入失败若缺口也无法持久化则后续查询可能不知道漏记，以及会话 ID 第一阶段仅进程内存在、退出后无法恢复会话。

- [ ] **步骤 3：执行完整验证。**

```bash
pnpm exec vitest run packages/models/test/usage-ledger.test.ts packages/agent/test/loop.test.ts packages/agent/test/summarizer.test.ts packages/agent/test/subagent.test.ts packages/cli/test/session.test.ts packages/cli/test/init.test.ts packages/cli/test/profile.test.ts packages/cli/test/reqs-plan.test.ts packages/runner/test/task9.test.ts
pnpm test
pnpm typecheck
pnpm build
```

预期全部退出码 0；若有环境依赖失败，记录准确命令和输出，不宣称通过。运行 `git status --short` 和 `git diff --stat`，确认无意外文件、无提交；检查未跟踪的设计文档保持原样。

## 设计边界与待决事项

- 第一阶段不存在可恢复会话，因此设计中的“恢复沿用同一会话累计”留待后续持久化会话阶段；本阶段只保证进程内 ID 和 `/clear` 切换，不创建恢复入口。
- 现有 `UsageMeter.measure` 将缺失缓存计数按 0 估价；这与“未知不得假设零”冲突。新账本使用保守独立计价，不改变 runner 历史结果口径，并在 README 说明可能不同。
- 配置引用只能确定请求发送的 provider/model ID；目前三处调用没有统一暴露服务端实际重定向模型 ID。首版按发送的 ID 分组并明确标注，不虚构服务端返回值；若必须统计服务端重定向后的模型，需要另行确认 provider 响应元数据契约。
- 文件级原子提交避免多进程交错，但异常断电与外部删除不能保证不丢记录；无缺口标记时查询无法证明完整。数据库事务、持久化会话、聊天压缩均不在此阶段。
- 终审明确两套边界：内置 OpenAI/Anthropic 以模型 fetch 为账本边界，其他注入模型以 `doGenerate` 为账本边界；实际进入 SDK 的生成及其预处理失败仍保留旧计数和严格审计（摘要取消例外）。明确的本地空消息守卫在 SDK 外直接阻断，不计数、不审计、不容错。内置 OpenAI 从 SDK 已暴露的原始用量或错误回执提取白名单字段，不额外读取响应流；无法取得的字段保持未知。
