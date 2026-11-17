# crosscheck

面向**已启动、手工配置并经人确认的可信测试项目**的本地 Chromium 浏览器 / HTTP / 可选 PostgreSQL AI 验收工具。AI 可自动操作页面、采集脱敏证据，再由执行器与独立 reviewer 双判；FAIL 是疑似 bug，待人工复核。浏览器无网络隔离，不适用于不可信页面或生产环境。

## 安装

```bash
npm i -g crosscheck
# 需要浏览器操作或真实浏览器测试时安装 Chromium；HTTP-only 不启动它
crosscheck --help
```

## 用法

无参数运行 `crosscheck` 在 stdin、stdout 均为 TTY 时进入交互会话。使用 `/init`、`/reqs`、`/plan`、`/review`、`/run`、`/report`、`/help` 和 `/exit`；参数与独立命令相同，含空格的路径使用引号，例如 `/review --project "my project"`。审核每次重新读取所选项目的确认记录，`q` 或顶层 `Esc` 返回聊天。命令失败显示退出码但不退出会话；Ctrl+C 取消当前操作并等待清理，空闲时使用 `/exit`。

普通文本通过当前工作目录项目配置的 `planner` 模型回答，只提供当前磁盘上的待审核数量和运行次数摘要及有限聊天历史，不需要确认人，也不提供工具或人工确认权限。模型配置和摘要错误会显示在会话中；聊天历史不持久化。带参数的一次性调用及退出码不变。

可使用 `init → reqs → review → plan → review → run` 流程：

| 命令 | 用途 |
|---|---|
| `init [--openapi <文件>]...` | 缺少配置时写 `.crosscheck/config.yaml` 模板并退出 2；配置完成后扫描项目并生成七份画像草稿 |
| `reqs --module <id>` | 从配置的 `requirementsDocs` 提取带来源的条款草稿 |
| `review [profile\|clauses\|cases\|results]` | 交互审核画像、条款、用例与运行结果 |
| `plan --module <id>` | 画像全部确认、条款确认后，生成用例草稿 |
| `run` / `report <runId>` | 执行已确认用例 / 从历史快照离线重建报告 |

生成命令只写草稿，不会自动确认；`run` 仍要求人工确认与凭证、网络授权等门禁。

详细手工接入指南、能力边界与安全约束见项目仓库：
https://github.com/yao147258/crosscheck
