# crosscheck

面向**已启动、手工配置并经人确认的可信测试项目**的本地 Chromium 浏览器 / HTTP / 可选 PostgreSQL AI 验收工具。AI 可自动操作页面、采集脱敏证据，再由执行器与独立 reviewer 双判；FAIL 是疑似 bug，待人工复核。浏览器无网络隔离，不适用于不可信页面或生产环境。

## 安装

```bash
npm i -g crosscheck
# 需要浏览器操作或真实浏览器测试时安装 Chromium；HTTP-only 不启动它
crosscheck --help
```

## 用法

无参数运行 `crosscheck` 在 stdin、stdout 均为 TTY 时进入交互会话。使用 `/init`、`/profile`、`/reqs`、`/plan`、`/review`、`/run`、`/report`、`/impact`、`/status`、`/help`、`/clear` 和 `/exit`；参数与独立命令相同，含空格的路径使用引号，例如 `/review --project "my project"`。审核每次重新读取所选项目的确认记录，`q` 或顶层 `Esc` 返回聊天。命令失败显示退出码但不退出会话；Ctrl+C 取消当前操作并等待清理，空闲时使用 `/exit`。

`/status [--project <目录>]` 只读展示推断的项目阶段、待审核数量和最新测试运行；运行缺失、未完成或损坏时明确提示。结果待裁决数量仅针对最新运行，阶段为推断而非完成保证。

普通文本通过当前工作目录项目配置的 `planner` 模型回答，只提供当前磁盘上的待审核数量和运行次数摘要及有限聊天历史，不需要确认人，也不提供工具或人工确认权限。模型配置和摘要错误会显示在会话中；会话历史作为会话状态不持久化，但聊天请求默认记录到用户目录的 `.crosscheck/chat-requests.jsonl`，请求体可能包含聊天历史和其他敏感内容；脱敏不能保证识别所有秘密，请限制日志访问并谨慎分享。带参数的一次性调用及退出码不变。

可使用 `init → review notes → profile → review profile → reqs → review clauses → plan → review cases → run` 流程：

| 命令 | 用途 |
|---|---|
| `init [--refresh]` | 缺少配置时写 `.crosscheck/config.yaml` 模板并退出 2；配置完成后扫描项目并生成 `.crosscheck/notes.md` 草稿，已确认笔记默认跳过；`--refresh` 强制刷新并尝试合并人工补充 |
| `profile [--openapi <文件>]...` | 笔记确认后，结合结构化事实扫描与已确认笔记生成七份画像草稿 |
| `reqs --module <id>` | 从配置的 `requirementsDocs` 提取带来源的条款草稿 |
| `review [notes\|profile\|clauses\|cases\|results]` | 交互审核笔记、画像、条款、用例与运行结果 |
| `plan --module <id>` | 画像全部确认、条款确认后，生成用例草稿 |
| `impact [--since <commit>] [--json]` | 只读比较 Git 基线与当前磁盘，解释需求、笔记到画像与用例的级联影响 |
| `run` / `report <runId>` | 执行已确认用例 / 从历史快照离线重建报告 |

生成命令只写草稿，不会自动确认；`profile` 要求笔记已确认，编辑后须重新确认；`plan` 要求七画像和相关条款已确认，`run` 还要求用例确认及凭证、网络授权等门禁。

`init` 不再生成画像，原 `init --openapi <文件>` 改为 `profile --openapi <文件>`，该参数可重复。旧项目已有画像及其有效确认不受影响，但运行 `profile` 仍需先生成并确认笔记；已确认画像重跑时跳过。未确认或已修改的笔记重跑 `init` 会被覆盖；`--refresh` 将旧笔记作为上下文，合并人工补充不保证成功，生成后须重新审阅确认。

扫描是预算内的最佳努力，不保证覆盖整个项目；忽略规则、数量和大小等限制可能导致遗漏。项目扫描仅处理根目录 `.gitignore` 的有限子集，不保证支持子目录规则、`**` 或取反语义；按有限名称及扩展名规则忽略常见凭证文件，`.env.example` 是例外，无法识别非标准凭证文件，因此可能扫描本应忽略的非标准秘密。脱敏不能保证识别所有秘密；文件名、摘录和笔记等内容可能发送给配置的模型服务，运行前请检查内容与授权，分享生成物前人工检查。

### 变更影响分析

```bash
crosscheck impact --project "my project"
crosscheck impact --since HEAD~1 --project "my project"
crosscheck impact --since <commit> --json --project "my project"
```

默认比较 `HEAD` 与当前磁盘（不是单独的暂存区）。被测项目需将相关需求文档、项目配置、笔记、画像、条款和用例纳入 Git；先检查敏感内容，不要加入凭证、全局密钥或运行证据。历史缺失、解析失败或引用缺失会报告不完整，不会冒充“无影响”。

命令不需要模型密钥、不调用模型、不写文件，也不改变确认状态。为避免 Git 惰性获取导致联网或写入，首版拒绝 partial/promisor 仓库及使用 alternates 共享对象库的仓库，请使用完整且独立的仓库。分析与报告达到资源上限时会报告不完整。报告区分实际变更、显式依赖影响、可能影响和分析缺口；自然语言步骤的依赖没有完整记录，可能影响范围会保守扩大。确定依赖不等于确定失败，未发现关联不保证无影响；首版不自动重新生成或使下游失效。`0` 表示分析完整（即使有影响），`2` 表示无效基线/输入不完整/中断，`3` 表示宿主故障。

详细手工接入指南、能力边界与安全约束见项目仓库：
https://github.com/yao147258/crosscheck
