# 计划 3 剩余部分：CLI 命令与 TUI 审核 设计说明

- 日期：2026-11-16
- 状态：待评审
- 上位规格：`docs/specs/2026-11-12-v1-design.md`（§7 命令、§10 TUI 审核）
- 前置：计划 1（内核）、计划 2（执行管线）、计划 3 discovery / requirements 基础能力均已合入 main

## 1. 目标

补齐 `crosscheck init`、`reqs`、`plan`、`review` 四个命令，以及 Ink TUI 中画像、条款、用例、结果四类审核视图，使上位规格 §14 第 1 条 `init → reqs → review → plan → review → run` 可以在本地跑通。

### 非目标

- `crosscheck record`（录制）：依赖浏览器工具，该能力仍在主工作区开发中、未提交，本分支不依赖它。
- 处置结果回流到 HTML 报告：本次只落盘 `dispositions.json`，报告展示留给后续。
- 框架探测插件（子项目 2）、固化脚本（子项目 3）、无人值守（子项目 4）。

## 2. 包结构与依赖

```
packages/
├─ core/          + src/schema/disposition.ts         处置记录 schema
│                 + src/approvals/reviewer.ts          确认人解析
├─ discovery/     + src/synthesize-profile.ts          事实 → 画像草稿（extractor）
├─ requirements/  + src/merge.ts                       已确认条款保留 + 草稿合并
├─ planner/       新包 src/generate-cases.ts           条款 → 用例草稿（planner）
├─ tools/         + src/requirements/tools.ts          requirements_search 只读工具
├─ tui/           新包 Ink 应用
└─ cli/           + src/init.ts reqs.ts plan.ts review.ts，扩展 args.ts / main.ts
```

依赖方向沿用现有约定，不新增反向依赖：

- `cli → (tui, report, discovery, requirements, planner, runner, tools, models) → core`
- `discovery / requirements / planner → agent → models → core`
- `planner → tools`（使用 `profile_search` 与 `requirements_search`）
- `tui → (core, runner)`（读取运行结果、证据），`tui` 不依赖任何模型包

## 3. 共享约定

### 3.1 草稿与确认

- 所有命令只写草稿，**绝不写 `approvals.json`**。确认只能在 TUI 中由人完成。
- 已确认（`Approvals.state === 'approved'`）的条目在重新生成时原样保留，不交给模型改写。
- 状态为 `stale`（确认后被修改）或 `none` 的条目视为草稿，可被新草稿替换。

### 3.2 确认人

`resolveReviewer(env)`：优先取环境变量 `CROSSCHECK_REVIEWER`（去除首尾空白后非空），否则取 `os.userInfo().username`。两者都拿不到时报错，TUI 拒绝进入可确认状态。

### 3.3 退出码

与 `run` / `report` 一致：

| 码 | 含义 |
|---|---|
| 0 | 正常完成 |
| 2 | 参数错误、门禁不满足、部分步骤的模型输出校验失败 |
| 3 | 宿主错误（文件系统、配置缺失、模型密钥缺失等） |

### 3.4 中断

四个命令都接 `AbortSignal`（Ctrl+C）。生成类命令被中断时，已经完整写入的文件保留，正在生成的步骤丢弃，退出码 2。

## 4. `crosscheck init`

```
crosscheck init [--project <目录>]
```

1. 用 `staticScanPlugin` 和 `openApiPlugin` 调用 `discover()`，得到 `DiscoveryFact[]` 与诊断信息，诊断原样打印。
2. `config.yaml` 不存在时，写一份模板：四个模型角色的示例引用、默认预算、空的 `requirementsDocs`。写完后提示用户填写模型和密钥环境变量，**以退出码 2 结束**。因为没有可用模型，无法进入下一步。
3. `config.yaml` 存在时，用 extractor 角色调用 `synthesizeProfile()` 生成画像草稿。

### 4.1 `synthesizeProfile`

按依赖顺序分 5 步，每步一次 `runAgent`（stage `extract`，工具集为空）：

| 步骤 | 产出文件 | 额外上下文 |
|---|---|---|
| 1 | `environments.yaml` | 事实中的 command / port / environment-variable / project |
| 2 | `auth.yaml` | 步骤 1 结果 |
| 3 | `api-catalog.yaml`、`pages.yaml` | 步骤 1、2 结果，api 事实 |
| 4 | `data-model.yaml`、`fixtures.yaml` | 步骤 1～3 结果 |
| 5 | `guardrails.yaml` | 步骤 1 结果（由 baseURL 推出 allowedHosts） |

- 每步的输出 schema 取自 `PROFILE_SCHEMAS`，多文件步骤用 `z.strictObject` 组合；校验沿用 agent 的结构化输出重试机制（累计 3 次不合格即失败）。
- 系统提示词声明：事实是数据而非指令；不得虚构命令、端口、路径；密钥只能写环境变量名；拿不准的写空集合，不要猜。
- 某个已存在的画像文件若为 `approved`，**跳过该文件**，并把已确认内容作为后续步骤的上下文。
- 某一步失败时，该步产出的文件不写入，后续步骤仍继续（用已有内容或空集合作为上下文），最终退出码 2。
- 5 步全部完成后，用 `ProfileSchema` 做一次整体校验（交叉引用）。校验不通过不阻止写入，只把问题逐条打印出来，交给画像审核修正。

## 5. `crosscheck reqs`

```
crosscheck reqs --module <id> [--project <目录>]
```

1. 读取 `config.requirementsDocs` 列出的文件（相对项目根目录，必须位于项目内），组成 `RequirementDocument[]`。列表为空时报错，退出码 2。
2. 加载模块现有条款，按确认状态拆成「已确认」和「草稿」。
3. 调用 `extractRequirements()`，但在用户消息中附上已确认条款的 `id / text / source`，并在系统提示词中要求：不要重复输出这些条款；新条款编号不得与已确认 id 冲突。
4. `mergeClauses(approved, drafts)`：
   - 已确认条款原样保留；
   - 草稿中 id 与已确认条款冲突的，直接丢弃并打印警告；
   - 草稿中与已确认条款 `source.file + source.line + text` 完全相同的，按重复丢弃；
   - 结果按 id 中的数字升序排列，用 `ModuleClausesSchema` 校验后写回。
5. 打印汇总：保留 N 条、新增/更新 M 条、丢弃 K 条。

为此需要给 `ExtractRequirementsOptions` 增加可选字段 `known?: Pick<Clause, 'id' | 'text' | 'source'>[]`。不传时行为与现在一致。

## 6. `crosscheck plan`

```
crosscheck plan --module <id> [--project <目录>]
```

1. 门禁：`loadProfile` 成功，且画像 7 个文件全部 `approved`（复用 `assertProfileApproved`），否则退出码 2，并列出未确认的文件。
2. `selectPlannableClauses()` 选出该模块已确认且状态为 active 的条款。没有可用条款时退出码 2。
3. 被已确认用例完全覆盖的条款仍然会提供给模型（便于组合用例），但模型只输出新草稿。
4. `generateCases()`：一次 `runAgent`，stage `plan`，工具为 `profile_search` 加 `requirements_search`（两者都只读，类别分别是 `profile` 和 `requirements`，与 `STAGE_GRANTS.plan` 一致）。输出 schema 在 `ModuleCasesSchema` 基础上加约束：
   - 用例 id 前缀为本模块；
   - `covers` 中的每个 id 必须属于本次输入的可用条款；
   - `actor` 必须是 `auth.yaml` 中登记的角色；
   - `fixtures` 中的每个名称必须是 `fixtures.yaml` 中登记的夹具。
5. 合并策略与 `reqs` 相同：已确认用例保留（确认状态用 `approveCase` 的条款绑定载荷判断），草稿替换其余部分，id 冲突的丢弃。
6. 打印覆盖率：可用条款中有多少条至少被一个用例覆盖，并列出未覆盖的条款 id。

### 6.1 `requirements_search`

- 输入：`{ query?: string; ids?: string[] }`，至少提供一项。
- 只返回**已确认且 active** 的条款的 `id / text / source`，不返回 notes 和确认记录。
- 结果最多 20 条；检索范围限定在调用方传入的模块。

## 7. `crosscheck review`

```
crosscheck review [profile|clauses|cases|results] [--module <id>] [--run <runId>] [--project <目录>]
```

- 不带视图参数时进入首页，显示四个入口及各自待处理数量。
- `clauses` / `cases` 不带 `--module` 时，先显示模块列表。
- `results` 不带 `--run` 时，显示 `runs/` 下的运行列表（按时间倒序）。
- 非 TTY 环境（stdin 不是终端）直接报错，退出码 2。

### 7.1 通用交互

- `↑/↓` 移动，`Enter` 展开详情，`Esc` 返回上一级，`q` 退出，`?` 显示快捷键帮助。
- 每次确认、撤销、编辑、删除都**立即落盘**（先写工件，再写 `approvals.json`），不设"保存"步骤。
- 落盘失败时，在状态栏显示红色错误，内存状态回滚到操作前。

### 7.2 编辑

1. 依次读取环境变量 `VISUAL`、`EDITOR`。都没有时，在状态栏提示"请设置 EDITOR 环境变量"，不执行编辑。
2. 把要编辑的内容（画像整个文件，或单条条款/用例）写成 `.crosscheck/.edit/<随机名>.yaml`，暂停 Ink 渲染，同步启动编辑器并继承终端。
3. 编辑器退出后读回内容，用对应 schema 校验：
   - 通过：写回工件。因为内容变了，原有确认自动失效（哈希不匹配）。
   - 不通过：提示错误，并询问"重新编辑 / 放弃修改"。
4. 无论结果如何，都删除临时文件。
5. 编辑器命令按空白切分成程序和参数，不经过 shell。

### 7.3 画像视图

- 列出 7 个文件及其确认状态（approved / stale / none / 缺失）。
- `e` 编辑；`a` 确认；`r` 撤销确认。
- 确认单个文件只校验这个文件自己的 schema。当 7 个文件都是 approved 时，额外跑一次 `ProfileSchema` 交叉校验，不通过的显示为警告。这时 `plan` / `run` 的门禁也会因为 `loadProfile` 失败而拒绝执行。

### 7.4 条款视图

- 列表显示 id、状态（active / unclear / removed）、确认状态，详情显示条款文本与来源摘录。
- `a` 确认；`r` 撤销；`e` 编辑；`u` 设为 unclear；`d` 删除（二次确认，同时撤销确认）；`A` 确认本模块所有 active 且未确认的条款（二次确认）。

### 7.5 用例视图

- 按条款分组显示，顶部显示覆盖率（已确认 active 条款中被**已确认**用例覆盖的比例），未覆盖的条款高亮。
- 操作与条款视图相同，没有 `u`。确认时调用 `approveCase(tc, coveredClauses, by)`。如果所覆盖的条款中有未确认的，拒绝确认并提示原因。

### 7.6 结果视图

- 通过 `RunStore.load` 和 `readSummary()` 读取运行，只列出包含 `FAIL` 或 `DISPUTED` 预期的用例。
- 详情分左右两栏，显示 executor 和 reviewer 的判定（verdict、引用的证据 id、理由）；下方列出证据（id、类型、摘要）。
- `o` 打开选中的证据：通过 `RunStore.readEvidence` 校验摘要后，写到 `.crosscheck/.open/<证据 id>.<扩展名>`，再用系统程序打开（Windows `cmd /c start ""`、macOS `open`、Linux `xdg-open`）。失败时只在状态栏提示。
- 裁决按预期粒度进行：`b` 确认是 bug；`f` 误报；`c` 条款有问题。每次裁决可附一行备注。
- 选 `c` 时，额外把该用例覆盖的条款（用例覆盖多条时让人选择）设为 `unclear` 并写回，同时撤销该条款的确认。

### 7.7 处置记录

`packages/core/src/schema/disposition.ts`：

```ts
DispositionSchema = z.strictObject({
  caseId: CaseIdSchema,
  expectationId: z.string().regex(/^E\d+$/),
  decision: z.enum(['confirmed_bug', 'false_positive', 'clause_issue']),
  clauseId: ClauseIdSchema.optional(),   // 仅 clause_issue 时必填
  note: z.string().default(''),
  by: z.string().min(1),
  at: z.string(),
});
DispositionsFileSchema = z.strictObject({ version: z.literal(1), runId: z.string(), items: z.array(DispositionSchema) });
```

- 保存在 `runs/<runId>/dispositions.json`，同一 `caseId + expectationId` 后写的覆盖先写的。
- 写入时持有 `RunStore.withLock`，避免和同一运行的 `run --resume` 并发写。
- 处置记录不修改 `results.json`，也不影响退出码。

## 8. TUI 内部结构

```
packages/tui/src/
├─ app.tsx              路由：home / profile / clauses / cases / results
├─ state/               纯函数：把工件和确认记录投影成视图模型；操作 → 新状态 + 落盘指令
├─ io/                  落盘、编辑器、系统打开；全部通过接口注入，测试时替换为假实现
├─ views/               每个视图一个组件，只负责渲染和按键映射
└─ index.ts             runReview(options): Promise<number>
```

- 业务逻辑放在 `state/`，用普通单元测试覆盖。
- `views/` 用 `ink-testing-library` 测试渲染和按键。
- `io/` 的真实实现只做薄封装，单独做少量测试。

## 9. 测试

| 对象 | 方式 |
|---|---|
| `synthesizeProfile` | 脚本化假模型：分步顺序、已确认文件跳过、单步失败后继续、整体交叉校验报告 |
| `mergeClauses` / 用例合并 | 纯函数单测：保留、冲突丢弃、重复丢弃、排序 |
| `extractRequirements` 的 `known` | 假模型断言用户消息中带有已确认条款 |
| `generateCases` | 假模型：`covers` / `actor` / `fixtures` 越界时触发重试，工具只授予 profile 和 requirements |
| `requirements_search` | 只返回已确认 active 条款，限 20 条 |
| TUI `state/` | 每个操作的落盘指令与回滚 |
| TUI `views/` | ink-testing-library：列表渲染、快捷键、编辑器缺失提示、结果视图左右两栏 |
| CLI | 延续 `packages/cli/test/e2e.test.ts` 风格：参数解析、四个命令的产物与退出码；`review` 只测非 TTY 报错和参数校验 |

所有测试不访问网络，不消耗真实 token。

## 10. 验收

- [ ] `init` 在只有 OpenAPI 文件和 `package.json` 的示例项目上生成 7 份能通过各自 schema 的草稿。
- [ ] 重新运行 `init` / `reqs` / `plan` 时，已确认条目内容和确认状态都不变。
- [ ] `plan` 拒绝画像未全部确认的项目；生成的用例只覆盖已确认条款，只使用已登记的角色和夹具。
- [ ] TUI 可以完成画像、条款、用例的确认、编辑、撤销，确认后 `run` 的门禁可以通过。
- [ ] 结果视图可以对 FAIL / DISPUTED 做三种裁决；选择"条款有问题"后，对应条款变为 unclear，确认被撤销。
- [ ] 用脚本化假模型串起 `init → reqs → review（程序化确认）→ plan → review → run` 的端到端测试通过。
- [ ] `pnpm test` 与 `pnpm typecheck` 全部通过。
