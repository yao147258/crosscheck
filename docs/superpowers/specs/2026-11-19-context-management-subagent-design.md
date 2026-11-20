# 上下文管理与 SubAgent 基础设施设计说明

- 日期：2026-11-19
- 状态：已确认（待审阅文档）
- 基础：变更影响分析（main 2b36937）
- 参考：Claude Code 的分层压缩、索引常驻/正文按需、子代理上下文隔离、前缀稳定以命中 prompt cache

## 背景

当前上下文治理按条数/字符/字节上限：TUI 聊天固定保留 20 条；`agent/src/context.ts` 以字符阈值压缩旧工具结果并按 ID 物化证据；`models` 已有 `contextWindow`（模型引用 `[size]` 后缀）与 `estimateTokens`，但只用于推导 `maxOutputTokens`。没有按窗口推导的压缩策略、没有模型摘要、没有 prompt caching，也没有子代理。plan/reqs 把全部输入一次塞入，模块大时会超窗口。

## 分期

| 期 | 内容 | 包 |
|---|---|---|
| 1（本文） | ContextManager、分层裁剪、摘要分级、prompt caching、SubAgent 原语 | agent、models、core |
| 2 | 执行阶段探索子代理 | runner |
| 3 | plan 按条款分批生成 | planner |
| 4 | TUI 聊天 `/context`、`/compact`、只读查询子代理 | cli、tui |
| 5 | init/profile 分区扫描 | discovery |

2–5 期各自走设计、计划、实现流程，均依赖第 1 期，相互独立。

## 目标与非目标

目标：按模型窗口以 token 预算管理上下文；保持前缀稳定以命中缓存；提供权限只收窄、预算分账、上下文隔离的子代理原语，覆盖“模型自主委派”和“宿主编排扇出”两种形态；为后续 session 化预留接缝（`agentId`/`parentId` 事件、独立的 ContextManager）。

非目标：本期不接入任何具体场景；不改 `STAGE_GRANTS` 取值、CLI 命令和报告格式；不新增模型角色（子代理继承父阶段角色及主备候选）；不引入 tiktoken 等精确分词；不做暂停/恢复或会话持久化。

## 架构选择

采用在现有 `runAgent` 上增量扩展（方案 A），并预留接缝。未采用 Session/Orchestrator 重构（方案 B）：它需迁移 6 个生产调用方并重新证明宿主异常优先、调用结果补齐、finish 单独调用、证据逐候选物化、invalid 额度等全部语义，工作量约为 A 的 2–3 倍，且暂停/恢复等收益目前无需求。未采用纯宿主编排（方案 C）：无法支持执行中由模型决定的探索。

## 一、ContextManager

### 位置与兼容

新增 `agent/src/context-manager.ts` 导出 `ContextManager` 类，不依赖 `runAgent` 内部变量，可被 TUI 聊天单独使用。`context.ts` 的 `compressContext`、`prepareContext`、`boundedText` 保留并作为内部确定性裁剪层，导出不变。`runAgent` 中原 `prepareContext` 调用改为 `contextManager.prepare(messages, candidate)`；`RunAgentOptions.contextPolicy` 保持兼容，新增可选 `contextManager`，省略时按 `stage` 构造默认实例。

### 预算推导

对每个真实候选（含重试、备用）分别计算：

```text
W = candidate.contextWindow（默认 DEFAULT_CONTEXT_WINDOW）
R = min(round(W × 0.15), 32_000)        输出预留
F = estimate(system + 工具 schema)       固定开销
I = W − R − F − 1_024                    可用输入
```

旧工具结果单条上限、证据文本上限、附件累计上限由 I 按比例推导（附件累计不超过 I 的 40%，旧工具结果单条不超过 I 的 3%，均另以现有默认值为下限保护）。显式 `contextPolicy` 字段优先。PNG 字节上限保持现有语义。

估算沿用 `estimateTokens`，并修正其对图片字节的处理：`Uint8Array`/`Buffer` 不再按 JSON 展开计数，而是每张图片按固定 1600 token 估算（现状会把截图字节序列化为 `{"0":…}`，一张 200 KB 截图被估成数十万 token 而误报超窗口）。每次成功调用后以 `usage.inputTokens ÷ 本次估算` 计算校准系数，仅在大于当前系数时上调，作用于本次运行内的同一候选；usage 缺失或为 0 时忽略。

### 分层裁剪

证据附件先按 ID 物化，历史预算 H = I − 附件估算。历史估算超过水位线时依次执行，满足目标即停：

| 层 | 动作 | 用模型 |
|---|---|---|
| L0 | 旧证据附件降为 ID 占位（现有） | 否 |
| L1 | 保留最近轮之外的工具结果超阈值时截为预览 + evidenceIds（现有，阈值改为 token 推导） | 否 |
| L2 | 将完整保留轮数逐步降至 1；更早的工具结果只保留 `{tool, ok, evidenceIds}` | 否 |
| L3 | 模型摘要：把更早消息替换为一条结构化摘要 | 是 |
| 兜底 | 抛出现有“输入超出窗口”不可重试错误 | — |

不变式：系统提示与首条任务消息（条款、用例等）永不修改；每个 tool-call 与其 tool-result 成对保留或成对降级；evidenceIds 在任何层都不丢失。

### 摘要分级

`allowSummary` 由阶段常量决定，不可配置：`execute`、`review`、`prepare` 固定为 false，越过 L2 直接兜底；`extract`、`plan` 及后续聊天、profile 场景允许 L3。摘要由当前候选模型生成，输出固定结构 `{goal, done, findings, evidenceIds, pending}`，以 `[上下文摘要，非实测证据]` 标记写入一条 user 消息。摘要调用计入预算与 `modelAttempts`，标记 `purpose: 'compact'`；失败、超时或不合格时不重试，退回 L2 结果再判定，仍超限则兜底。

### 水位线压缩与 prompt caching

为保持前缀字节稳定，压缩只在历史估算超过 H 的 85% 时触发，一次压至 H 的 60% 以下；两次压缩之间消息只追加。压缩结果作为“已定稿前缀”缓存，后续请求原样复用；仅当候选窗口相同时复用，窗口不同的候选独立重新裁剪。证据附件仍按每个候选重新物化，放在消息末尾，不进入已定稿前缀。

Anthropic provider（`@ai-sdk/anthropic` 4.x）通过消息级 `providerOptions.anthropic.cacheControl: { type: 'ephemeral' }` 设置断点：system 消息末尾一个（Anthropic 拼接顺序为 tools → system → messages，可同时覆盖工具定义），已定稿前缀末尾一个，合计不超过 4 个。system 以 `SystemModelMessage`（`{ role: 'system', content, providerOptions }`）传给 `generateText` 的 `system` 参数，无需移入 messages。缓存断点打在历史（已定稿前缀加其后追加的消息）最后一条上，附件之前。OpenAI Responses 为服务端自动缓存，不加断点。provider 类型由 `ModelCandidate` 新增的 `providerType` 字段提供。

用量：`ModelAttempt.usage` 新增可选 `cacheReadTokens`、`cacheWriteTokens`，取自 `usage.inputTokenDetails`。`pricing` 新增可选 `cacheReadPerMTok`、`cacheWritePerMTok`；未配置时按 `inputPerMTok` 计费，不判为 pricing 未知。

### 上下文报告

`prepare()` 返回 `ContextReport`：`ref`、窗口 W、可用输入 I、各部分估算（system、tools、task、history、attachments）、校准系数、本次触发的层、是否命中水位线。`RunAgentOptions` 新增 `onContextPrepared` 回调，事件带 `agentId`/`parentId`。runner 将其写入 `models.json`；第 4 期 `/context` 用同一结构渲染。

## 二、SubAgent 原语

新增 `agent/src/subagent.ts`：

```ts
spawnSubAgent(parent: ParentContext, spec: SubAgentSpec): Promise<SubAgentResult>
runSubAgents(parent: ParentContext, specs: SubAgentSpec[], opts: { concurrency?: number }): Promise<SubAgentResult[]>
```

`ParentContext` 包含父 `stage`、模型候选、已授予工具、`BudgetTracker`、signal、审计回调、`agentId`。`SubAgentSpec` 包含 `name`、`task`、可选 `context`、`tools`（工具名子集）、可选 `cap`（预算上限）、可选 `output`（zod schema，默认通用报告）。

### 模型自主委派

`RunAgentOptions` 新增 `delegates?: DelegateTemplate[]`。循环在内部为每个模板创建 delegate 工具并绑定当前父上下文，宿主无需取得循环内部状态。模板含 `name`、`description`、`tools`、`cap`。delegate 工具输入为 `{ task, context? }`。

### 权限

子代理工具集 = `grantTools(父 stage)` 授予结果 ∩ `spec.tools`；申请父阶段未授予或不存在的工具时在派生前同步抛错，不调用模型。子代理使用父 `stage`，阶段防作弊约束自动继承。嵌套深度固定为 1：子代理工具集永不包含 delegate 工具，子代理调用 `spawnSubAgent` 抛错。`review` 阶段无工具，因此无子代理。

### 上下文隔离

子代理从全新上下文开始，只接收 `spec.task` 与 `spec.context`，不继承父消息。子代理拥有独立 ContextManager，摘要权限按父阶段决定。

### 预算分账

`BudgetTracker` 新增 `child(cap?)`：子账本上限为 `cap` 与父剩余额度 50% 的较小值（步数、token、时长分别计算）；子代理的每次记录同时计入子账本与父账本，用例总预算不被突破。子代理 signal 为父 signal 与子账本超时的合并。子账本耗尽只阻断子代理。

### 回传协议

默认输出 schema：

```ts
{ summary: string /* ≤2000 字符 */, findings: Array<{ text: string; evidenceIds: string[] }>, status: 'done' | 'partial' }
```

宿主对 evidenceIds 做核验，只保留证据库中真实存在的 ID，丢弃的 ID 以 `[已丢弃无效证据ID: …]` 附注。delegate 工具返回给父代理的结果以 `[子代理结论，仅作导航线索，非实测证据]` 开头，并在约定字段中携带 evidenceIds，因此父代理后续 `prepare()` 通过 `collectEvidenceIds` 按 ID 物化原始证据；执行器判定依据仍是实测证据，`validateJudgements` 不变。

子代理 blocked（budget、invalid-output、reported、model-error）时父代理收到 `error-text` 并可继续；宿主异常（证据库、回调抛错等）原样透传，沿用“宿主故障优先”。

### 并发

delegate 工具随父循环逐个执行工具而天然串行；execute 阶段子代理与父代理共用同一 `BrowserHost`，页面状态共享、可变，不得并行。`runSubAgents` 用于宿主编排扇出，默认并发 3，各子账本平分父剩余额度的 50%（可由 `share` 调整），仅适用于只读或无状态工具；结果逐项返回 `{ status: 'done', output } | { status: 'blocked', reason, detail }`，任一项出现宿主异常时取消其余并抛出该异常。

### 审计接缝

子代理由 `spawnSubAgent` 分配 `agentId` 并携带 `parentId`；父代理的 `agentId` 由宿主通过 `RunAgentOptions.agentId` 提供，未提供时事件不带这两个字段，保持现有审计结构不变。子代理结束时触发 `onSubAgentFinished` 事件。`onModelAttempt`、`onToolCall`、`onContextPrepared` 事件均附带二者，trace 与 `models.json` 可还原为树。子代理阻断计入 `reliability.errors`，格式 `subagent:<name>:<reason>`。

### 复核独立性

复核输入仍由 `buildReviewInput` 仅以条款、预期、证据 ID 构造。子代理结论只存在于执行器消息中，永不进入复核者上下文。

## 三、后续各期接口约定

| 期 | 使用方式 | 本期保证 |
|---|---|---|
| 2 执行探索 | execute 阶段传 `delegates: [{ name: 'explore', tools: [...browser/http/profile 工具] }]` | delegate 由循环内部创建；delegate 工具不新增授权类别 |
| 3 plan 分批 | `runSubAgents` 按条款分组，`output` 为用例数组 schema，宿主合并、去重、校验 | 自定义 output schema；部分失败逐项返回 |
| 4 TUI 聊天 | 独立使用 `ContextManager` 的 `prepare`、`compact`、`report`；只读查询用 `spawnSubAgent` | ContextManager 不依赖 runAgent，`compact()` 可单独调用。`chat` 阶段与只读工件工具类别由第 4 期新增 |
| 5 分区扫描 | `runSubAgents` 按目录分区，extract 阶段工具，宿主汇总 | 同第 3 期 |

## 四、错误处理

| 情形 | 行为 |
|---|---|
| L0–L2 后仍超限且禁止摘要 | 抛出现有超窗口不可重试错误，结果 `blocked('model-error')`，信息附 ContextReport 摘要与 `[size]` 提示 |
| 摘要调用失败、超时或不合格 | 不重试，退回 L2 再判定，仍超限兜底 |
| 备用模型窗口更小 | 为该候选独立裁剪，不复用不同窗口的已定稿前缀 |
| 校准 usage 缺失或为 0 | 忽略本次校准 |
| 子代理越权工具或嵌套派生 | 派生前同步抛错，视为宿主编程错误 |
| 子代理 blocked | 父代理收到 error-text 继续；记录 `subagent:<name>:<reason>` |
| 子代理中宿主异常 | 原错误对象透传，宿主故障优先 |
| 父代理取消或超时 | 子代理经合并 signal 中止；父代理未执行调用沿用现有补齐逻辑 |
| 子代理回传无效 evidenceId | 宿主过滤并附注 |
| `runSubAgents` 部分失败 | 逐项返回；宿主异常时取消其余并抛出 |

## 五、测试

使用 vitest 与现有 `scriptedModel`：

- `context-manager.test.ts`：预算推导与显式 policy 优先；L0→L3 按需逐层触发；execute/review/prepare 下摘要模型调用次数为 0；水位线以下前缀字节一致、触发后降至 60% 以下；校准系数只升不降；备用模型窗口更小时重新裁剪；系统与首条任务消息不变；tool-call/result 成对。
- `cache.test.ts`：Anthropic 请求断点位置及数量不超过 4；OpenAI 请求无断点；`cacheReadTokens`/`cacheWriteTokens` 透传与计费，未配置缓存价按输入价计费。
- `subagent.test.ts`：权限只收窄、越权抛错；嵌套深度 1；子账本双记账及 50% 上限；回传标记与无效 ID 过滤；父代理按 ID 物化子代理证据；取消传播；宿主异常透传；`runSubAgents` 并发上限与部分失败语义；事件 `agentId`/`parentId` 正确。
- 回归：现有 `agent`、`tools` 展示及 runner 测试不修改并全部通过；`pnpm test`、`pnpm typecheck` 通过。
