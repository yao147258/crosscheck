# 交互会话模式（crosscheck 无参数启动）设计说明

- 日期：2026-11-17
- 状态：待评审
- 前置：`crosscheck init/reqs/plan/review/run/report` 六个命令与 Ink TUI 审核视图均已合入 main（见 `2026-11-16-plan3-cli-tui-design.md`）

## 1. 目标

`crosscheck`（不带子命令）在 TTY 下进入一个常驻的交互会话：

- 输入以 `/` 开头的斜杠命令（`/init /reqs /plan /review /run /report /help /exit`），等价于现在的一次性子命令，但执行完不退出进程，结果显示为一条消息，可以继续输入下一条。
- 输入普通文本，交给一个只读的 AI 助手回答（问项目情况、解释某次验收结果），助手不能写入、不能做确认类动作。

## 2. 非目标

- 不取消现有一次性调用：`crosscheck <command> ...`（带参数）行为、退出码、脚本/CI 用法完全不变。
- 助手不提供工具调用能力，不做证据级检索；只读取首页摘要粒度的快照（画像/条款/用例待处理数量、运行次数），更深入的问题仍需人工在 `/review` 的结果视图里看完整证据。
- 不新增模型角色、不改 `@crosscheck/core` 的 `ConfigSchema` / `@crosscheck/models` 的 `ROLES`：助手直接复用 `planner` 角色的模型配置。
- 不做会话持久化：聊天记录和已解析的 `ReviewSession` 只存在于本次进程内存里，退出即丢弃。
- 不支持会话内多项目切换；每条斜杠命令仍可以像现在一样单独传 `--project`，但这不是本次要新增的能力，维持 `parseArgs` 现状即可。

## 3. 入口分流

`packages/cli/src/args.ts`：

- `parseArgs([])`（无任何参数）不再抛错，返回 `{ command: 'session', project: process.cwd(), open: false }`。
- `CliArgs.command` 类型从 `Command | 'help'` 扩成 `Command | 'help' | 'session'`；`session` 不参与 `FLAGS`/`REPEATABLE` 校验（没有自己的参数）。
- 其余解析逻辑不变：只要 `args.length >= 1`，仍按现有六个子命令 + `--help` 走原路径。

`packages/cli/src/main.ts`：

- `cliMain` 新增 `case 'session': return await sessionCommand(args, log, deps, options.signal)`。

`packages/cli/src/session.ts`（新文件，结构参照 `review.ts`）：

1. TTY 门禁：`stdin`/`stdout` 都不是 TTY 时打印提示并返回退出码 2（和 `review` 一致）；不在这里强制解析确认人身份——确认人只在真正进入 `/review` 时才解析，这样纯聊天或跑 `/plan` 不需要先配置 `CROSSCHECK_REVIEWER`。
2. 组装三个注入给 `@crosscheck/tui` 的行为，调用其导出的 `runSession()`：
   - `runSlashCommand(line)`：见第 4 节。
   - `resolveReview()`：首次执行 `/review` 时调用，内部就是现在 `reviewCommand` 里那几行——`resolveReviewer(env)` → `new ArtifactStore(args.project)` → `ReviewSession.open(...)`；解析失败把错误信息作为聊天消息展示，不中断会话。解析成功后的 `ReviewSession` 在本次进程内缓存复用（和 `reviewCommand` 单次运行期间只开一次的语义一致）。
   - `chatReply(history, text)`：见第 5 节。

## 4. 斜杠命令分发

会话里一行输入先按开头字符分流：

- 不以 `/` 开头 → 整行作为聊天消息，走第 5 节。
- `/exit` → 结束会话，退出码 0（由 `tui` 的 `SessionApp` 调用 `exit(0)`）。
- `/review ...`（去掉开头 `/` 后首个词是 `review`）→ **不**走 `cliMain`，而是用现有 `parseArgs(['review', ...rest])` 解出 `view/module/runId`，交给 `SessionApp` 切换到"嵌入式审核模式"：直接挂载现有的 `<App env={...} initial={initialRoute(...)} onExitToParent={...} />`（见第 6 节），完整复用 `app.tsx`/`routes.ts`/`views/*` 现有代码，不新写任何审核逻辑。
- 其余（`/init /reqs /plan /run /report /help`）→ 去掉开头 `/`，按空白切词，直接调用现有的 `cliMain(tokens, { log: pushLine, dependencies, signal })`。这一步完全复用现有参数校验、各命令实现和退出码语义；唯一的差别是 `log` 把输出收集成这条消息的内容，而不是写 `console.log`，执行完也不会让进程退出。
  - 这里天然要求 `cliMain` 不会再走到它自己的 `review` 分支（因为 `review` 已经在上一步被截走），所以不会出现"已经在 Ink 渲染树里又调用一次 `runReview()` 自己 `render()`"的嵌套问题。
  - `cliMain` 抛出的 `GateError`/`InterruptedError`/宿主错误都已经被其自身的 try/catch 转成 `(log 消息, 退出码)`，这里直接拿返回值展示即可，不需要额外处理。

未知斜杠命令（如 `/foo`）会被 `cliMain`/`parseArgs` 当成未知命令报错，错误信息原样展示为一条消息，不影响会话继续。

## 5. 聊天（自由文本）

`packages/cli/src/session.ts` 里的 `chatReply(history, text)`：

1. 用已有的 `resolveModels(config, 'planner', deps, log)`（`context.ts` 里现成的函数）取模型候选；多个候选时和其它角色一样，主模型失败再退备用。
2. 系统提示词：声明助手只能基于只读摘要回答问题、不能执行任何写入或确认动作、遇到"请确认/修改"类请求要引导用户用对应斜杠命令或 `/review` 自己操作。
3. 只读上下文：复用 `@crosscheck/tui` 已有的 `loadHomeSummary(session)`（`state/home.ts`，`HomeView` 已经在用）取画像/条款/用例待处理数量、运行次数；若 `ReviewSession` 还未解析（用户还没碰过 `/review`），上下文里这部分留空并说明"尚未加载项目摘要"，不强制触发确认人解析。
4. 用 `ai` SDK 的 `streamText`（`tools: {}`，不授予任何工具）把"系统提示 + 摘要 + 最近若干轮历史 + 本次输入"传给模型，流式文本追加到当前这条助手消息里。
5. 不接 `BudgetTracker`、不接 `deps.resilience`：聊天是非门禁的辅助功能，失败（网络错误、模型报错）直接把错误文本当成助手回复展示，用户可以重新问一遍，不影响其它斜杠命令。

聊天历史只保存在 `SessionApp` 的内存状态里，随进程退出丢弃。

## 6. `@crosscheck/tui` 侧改动

```
packages/tui/src/
├─ app.tsx              + 可选 prop onExitToParent：nav.back() 在栈顶、nav.quit() 时
│                          优先调用 onExitToParent()，不传时行为与现在完全一致（exit(...)）
├─ session.ts            新增：runSession(options): Promise<number>，结构参照 index.ts 的 runReview——
│                          一次 render(<SessionApp/>) + waitUntilExit
├─ session-app.tsx       新增：SessionApp，持有 mode: 'chat' | 'review'
│                          · mode='chat' 时渲染 <ChatView/>
│                          · mode='review' 时渲染现有 <App env=... initial=... onExitToParent={() => setMode('chat')}/>，
│                            原样复用 profile/clauses/cases/results 全部既有视图
└─ views/chat.tsx        新增：消息列表 + 常驻输入框；自由文本输入沿用 views/results.tsx 里
                           备注输入的现成模式（useInput 累积字符 + backspace，不引入新依赖）
```

`RunSessionOptions`（`session.ts` 导出）大致形状：

```ts
interface RunSessionOptions {
  artifacts: ArtifactStore;
  editor: EditorHost;        // 复用，/review 内编辑仍要用
  open: (file: string) => Promise<void>;
  resolveReview: () => Promise<ReviewSession>;        // 懒解析，失败抛错由 SessionApp 捕获展示
  runSlashCommand: (line: string) => Promise<{ code: number; lines: string[] }>;
  chatReply: (history: ChatMessage[], text: string) => AsyncIterable<string>;
  signal?: AbortSignal;
}
```

`SessionApp` 不关心命令具体怎么执行、模型怎么调，只负责：消息流渲染、输入框、mode 切换、busy 态下阻止重复提交、Ctrl+C 中断正在执行的 `runSlashCommand`/`chatReply`（空闲时 Ctrl+C 不退出，footer 提示用 `/exit`）。

切到 `mode='review'` 时，`SessionApp` 先 `await options.resolveReview()`（结果缓存在自己的 state 里，之后的 `/review` 不重复解析），拿到的 `ReviewSession` 和 `options.editor`/`options.open`/`options.signal` 一起组成 `<App>` 需要的 `env: ReviewEnv`；`resolveReview()` 抛错时停留在 `mode='chat'`，把错误文本作为一条消息展示。

## 7. 退出码

- 会话模式 `process.exitCode`：`/exit` → 0；非 TTY 拒绝 → 2；Ctrl+C 中断正在执行的命令 → 沿用 `withInterrupt`/`InterruptedError` 现有语义（2）。
- 会话内某条斜杠命令本身的失败/非 0 退出码，**不影响会话继续**，只作为那条消息的展示内容（例如显示"`/plan` 退出码 2：模块 x 没有已确认且 active 的条款"）。这是和一次性 CLI 最大的语义差异，需要在 `--help` 文案和 README 里说明。

## 8. 测试

| 对象 | 方式 |
|---|---|
| `parseArgs([])` | 返回 `{command:'session',...}`，不再抛错 |
| `sessionCommand` | 非 TTY 报错退出码 2；`resolveReview` 失败不影响后续聊天/命令调用 |
| `runSlashCommand` | `/exit`、`/help`、未知命令、以及至少一个转发给 `cliMain` 的真实命令（用假 `dependencies` 验证不触发真实模型调用也能拿到预期错误码） |
| `chatReply` | 假模型断言：系统提示包含只读限制说明、历史记录被传入、流式分片被正确拼接 |
| `app.tsx` 的 `onExitToParent` | ink-testing-library：栈顶 `Esc`/`q` 调用回调而不是 `exit()`；不传时行为与现状快照一致（回归） |
| `SessionApp` / `ChatView` | ink-testing-library：输入回显、backspace、Enter 提交、mode 在 chat/review 间切换、busy 态拒绝重复提交 |
| CLI e2e | 延续 `packages/cli/test/e2e.test.ts` 风格，补一条"空参数 + 非 TTY → 退出码 2"的用例 |

所有测试不访问网络，不消耗真实 token（聊天测试用假模型/假 `streamText` 替身）。

## 9. 验收

- [ ] `crosscheck`（TTY，无参数）进入会话，输入 `/help` 显示现有 `HELP` 文案，`/exit` 正常退出且退出码 0。
- [ ] 会话内 `/init`、`/reqs --module x`、`/plan --module x`、`/run --module x`、`/report <runId>` 的产物与单独执行 `crosscheck init/reqs/plan/run/report` 完全一致，执行完不退出会话。
- [ ] 会话内 `/review`、`/review cases --module x` 等能进入和现在 `crosscheck review ...` 完全一样的审核视图，可以确认/编辑/撤销；`Esc` 回到栈顶后再 `Esc`/`q` 回到聊天首页而不是退出进程。
- [ ] 聊天只读：问"画像/条款/用例还有多少待审核"能拿到基于当前摘要的回答；要求助手"直接帮我确认画像"时，助手拒绝并引导使用 `/review profile`。
- [ ] `crosscheck <command> ...`（带参数）的行为、退出码、脚本调用方式与改动前完全一致（回归）。
- [ ] `pnpm test` 与 `pnpm typecheck` 全部通过。
