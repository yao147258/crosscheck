# init 一条命令完成笔记与画像：设计

日期：2026-11-23
状态：待审阅

## 目标

把 `init → review notes → profile → review profile` 合并为 `init` 一条命令，减少人工确认的工作量。
自动确认范围限于有证据、可由宿主核验的内容；其余留给人，且在同一条命令里完成审核。

## 非目标

- 不改 `reqs → review clauses → plan → review cases → run` 的人工门禁。
- 不把确认粒度改成条目级；确认记录仍是文件级、绑定内容哈希。
- 不改 `gate.ts` 的判定逻辑。
- 不移除 `profile` 命令（仍用于单独重跑画像）。

## 已定的决策

| 问题 | 决策 |
|---|---|
| 减少哪种人工参与 | 减少确认工作量：大部分内容不用人看，只看疑点。 |
| 自动确认范围 | 笔记、`api-catalog`、`pages`。`environments`、`auth`、`data-model`、`fixtures`、`guardrails` 始终由人确认。 |
| 核验未通过的条目 | 从 `api-catalog`/`pages` 剔除，剩余内容整份自动确认；被剔除项在 `init` 结束时汇总输出。 |
| 笔记 | 自动确认，确认人 `auto`。 |
| 剩余 5 份画像 | TTY 下 `init` 直接进入审核；非 TTY 下打印待确认清单并以退出码 2 结束。 |

## 流程

1. 与现状一致：读取或写入 `config.yaml`，已确认的笔记且未 `--refresh` 则跳过笔记生成。
2. 生成笔记并写盘，随后自动确认（`approvals.approve('notes', 'project', 文本, 'auto')`）。
3. 复用 `profile` 的生成逻辑生成七份画像草稿。`init` 接受 `--openapi <文件>`（可重复），含义与 `profile` 相同。
4. 对 `api-catalog` 与 `pages` 逐条核验，剔除未通过条目，写回，并自动确认这两份文件。
5. 其余 5 份：
   - TTY：进入 `review profile` 的审核视图，只列这 5 份，审核结束后 `init` 结束。
   - 非 TTY：输出待确认清单，退出码 2（与 `review` 在非 TTY 下拒绝并退出 2 的现有约定一致）。
6. 已确认画像沿用现有规则：重跑时跳过，不被覆盖。

笔记生成失败时仍返回 2，不继续生成画像。

## 条目核验规则

`pages` 与 `api-catalog` 的条目都带 `sources: {file, line, excerpt}[]`。条目通过核验的条件：

- 至少有一个来源满足：`file` 是项目内安全路径且存在，`line` 在文件范围内，脱敏后的该行包含 `excerpt` 的内容。
- 读取方式复用 `discovery` 里现有的项目读取与行清洗（`createProjectReader`、`readCleanLines`），与 `verify-findings.ts` 的核验口径保持一致。

未通过的条目整条剔除，不修改条目内容。若剔除后某份文件没有任何条目，则该文件不写入，也不自动确认。

## 确认记录

- 确认记录结构不变（`hash`、`by`、`at`）。自动确认时 `by` 固定为 `auto`。
- 不新增字段：`by === 'auto'` 即表示自动确认。
- 编辑文件后哈希不匹配，确认照常失效；`auto` 与人工确认没有区别。
- `review` 界面与 `/status` 显示确认人，使人能分辨 `auto` 与人工确认。

## 代码改动

- `packages/cli/src/profile.ts`：把生成与写盘逻辑抽成可复用函数，供 `profileCommand` 与 `initCommand` 共用；`profileCommand` 行为不变。
- `packages/cli/src/init.ts`：串联笔记、画像、核验、自动确认与审核。
- `packages/discovery/src/`：新增画像条目核验函数（输入画像条目与项目读取器，输出通过与被剔除的条目及原因）。
- `packages/core/src/approvals`：无结构改动；可增加 `AUTO_REVIEWER = 'auto'` 常量。
- `packages/cli/src/review.ts`：支持只审核指定的若干份画像，并显示确认人。
- `packages/cli/src/args.ts`：`init` 接受 `--openapi`。
- TUI 会话中的 `/init` 随之得到同样行为，审核视图在会话内打开。
- `README.md`、`docs/manual-integration.md`：更新流程与命令表。

## 错误与边界

- 并发修改检测沿用 `init`/`profile` 现有的"生成期间文件或确认记录被改"检查，不放宽。
- 中断（Ctrl+C）时不留下半写入的确认：自动确认放在对应文件写盘成功之后。
- 审核视图中途退出：已确认的保留，其余仍待确认；`init` 退出码按现有 `review` 约定（`q` 为 0，`Ctrl+C` 为 2）。
- 用户级 `reviewer` 身份要求不适用于 `auto`；但审核剩余 5 份时仍按现有规则取确认人。

## 风险

`auto` 确认让 `profile` 的"笔记已确认"门禁自动通过，`init` 不再保证有人看过笔记。笔记不直接决定怎么测：画像、条款、用例后面仍有人工门禁。
需求文档小节只在 `config.yaml` 的 `requirementsDocs` 为空时生效，且路径经过安全校验，不会越出项目目录。README 必须明确写出这一点。

## 测试

- 核验：来源存在且摘录匹配则保留；文件不存在、行越界、摘录不符、路径不安全则剔除。
- 剔除后整份无条目则不写入、不确认。
- `api-catalog`/`pages` 自动确认，`by` 为 `auto`；其余 5 份不会被自动确认。
- 编辑自动确认的文件后，确认失效。
- TTY 下进入审核且只列 5 份；非 TTY 下输出清单并退出 2。
- 已确认笔记与画像在未 `--refresh` 时被跳过；`--refresh` 行为与现状一致。
- `init` 完成后，`reqs`、`plan`、`run` 的门禁仍然要求条款与用例人工确认。
- 并发修改检测与中断场景不留下半写入的确认。
- `profile` 命令回归测试保持通过。

## 待实现阶段确认的细节

- 审核视图如何接受"只列指定画像"的参数，取决于 `review.ts` 现有结构。
- `/status` 展示确认人的具体位置。
