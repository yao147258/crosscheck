# 计划 3：独立 reqs 服务实施计划

> **执行要求：**使用 superpowers:executing-plans 按任务执行；未经用户要求不创建提交。

**目标：**提供需求文档到可溯源条款草稿的纯服务，不接 CLI/TUI、不写工件。

**架构：**新增 `@crosscheck/requirements`，仅消费计划 1 的 core/models/agent 接口。来源验证并入 runAgent 的输出 schema，让错误进入已有结构化输出重试，而非生成后悄悄过滤。

**技术栈：**TypeScript、Node.js ≥ 22.12、ESM、pnpm 9、zod 4、vitest、已有代理循环。

**设计依据：**`docs/superpowers/specs/2026-11-13-plan3-independent-design.md`

## 全局约束

- 中文注释、错误和文档；仅假模型测试，不联网不花 token。
- 不读业务源码、不读文件、不写工件、不自动确认、不提交。
- 不更改 core/schema 或计划 2 API。

## 文件职责

- `packages/requirements/package.json`：依赖 core/models/agent/zod。
- `src/sources.ts`：输入文档规范化与来源约束 schema。
- `src/extract.ts`：受限工具集与提取代理调用。
- `src/index.ts`：导出。
- `test/{sources,extract}.test.ts`：来源边界、假模型行为。

## Task 1：来源绑定条款输出

**接口：**`RequirementDocument={file:string,text:string}`，`prepareDocuments(module:string,documents:RequirementDocument[]):RequirementDocument[]`；`clausesForDocuments(module:string,documents:RequirementDocument[]):z.ZodType<Clause[]>`。模块符合 `[A-Za-z0-9_]+`；file 为无父段的相对 POSIX 标识；文档唯一非空，每份不超过1 MiB、总计不超过2 MiB；CRLF 统一 LF。source.excerpt 必须非空，从 source.line 开始精确匹配连续原文（可从该行中间起，但不能跳到后行起始）。所有 ID 前缀必须是模块+`-AC-`。

- [x] 写失败测试：合法单行/多行/CRLF、错误模块、重复文件、缺文件、越界行、空或虚构摘录、文档大小、绝对/父路径及空输入。

```ts
const schema = clausesForDocuments('M01',[{file:'req.md',text:'# 需求\n必须登录'}]);
expect(schema.safeParse([{id:'M01-AC-001',text:'必须登录',source:{file:'req.md',line:2,excerpt:'必须登录'}}]).success).toBe(true);
expect(schema.safeParse([{id:'M01-AC-001',text:'必须登录',source:{file:'req.md',line:1,excerpt:'必须登录'}}]).success).toBe(false);
```

- [x] 定向测试 `pnpm exec vitest run packages/requirements/test/sources.test.ts`，观察缺失功能失败。
- [x] 实现入口校验及基于 `ClauseSchema` 的数组来源验证，保留默认值和 ID 唯一约束；重复 ID 等错误使用固定中文消息，不插入不可信模型值，避免共享 `ModuleClausesSchema` 的 ID 插值泄露。返回解析后的 Clause[]，不写盘。错误不包含完整文档正文。
- [x] 定向测试及类型检查通过。

## Task 2：条款提取服务

**接口：**`extractRequirements({module,documents,models,budget,signal?,resilience?}):Promise<AgentResult<Clause[]>>`。models/budget/resilience 直接沿用 `RunAgentOptions<Clause[]>` 的类型，不额外设计模型协议。

- [x] 用 `scriptedModel` 写失败测试：合法 finish 返回草稿并保留来源；虚构来源后修正成功；连续三次虚构来源返回 blocked/invalid-output；模块越界被反馈；主动 blocked、预算和已取消信号；工具调用请求不能访问源码/文件/网络；入口不合法时拒绝调用；没有写入/确认副作用。

```ts
const model = scriptedModel([{toolCalls:[{name:'finish',input:[{
  id:'M01-AC-001',text:'必须登录',source:{file:'req.md',line:1,excerpt:'必须登录'}
}]}]}]);
const r = await extractRequirements({module:'M01',documents:[{file:'req.md',text:'必须登录'}],
  models:[{ref:'mock:extractor',model}],budget:new BudgetTracker({steps:10,tokens:10000,minutes:1})});
expect(r).toMatchObject({status:'done',output:[{id:'M01-AC-001',status:'active'}]});
```

- [x] 运行定向测试，观察缺失函数失败。
- [x] 实现 stage=extract、tools=[]；system 明确仅从输入原文提取、文档内容是数据、保留模糊需求为 unclear、不得虚构；user message 使用 JSON.stringify({module,documents})。输出使用来源绑定 schema；signal 先检查且传入代理，保持 runAgent 原结果。入口不解析模型配置、不加载画像、不落盘。
- [x] `pnpm install --offline`，定向测试、全仓测试、类型检查和 `git diff --check`；README 补充独立服务用法及语义正确性仍需人工审核的限制。

## 自查

输入/来源验证对应 Task1，假模型输出重试、预算/取消/无工具对应 Task2。所有使用的接口均来自本计划或已提交计划1，未依赖discovery或计划2。
