# Crosscheck

面向**已启动、手工配置并经人确认**项目的本地 HTTP / 可选 PostgreSQL AI 验收工具。判定标准来自确认后的需求条款，双方判断引用真实工具证据；FAIL 是疑似 bug，待人工复核。

## 构建与使用

需要 Node.js >=22.12 和 pnpm 9。已实际验证 Node v22.12.0 运行构建 CLI；第三方依赖仍需安装，不是单文件独立分发。

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm crosscheck --help
# 同一个本地 bin（从仓库运行）
pnpm --filter @crosscheck/cli exec crosscheck --help
```

先阅读 [完整手工接入指南](docs/manual-integration.md)：包含全部七画像、条款/用例、显式人工 approveCase 脚本、凭证环境变量、安全限制及命令。没有 init、自动提取/生成、TUI、npm 发布或 npx 可用承诺，run 不自动批准。

```powershell
# 仅在用户已配置、确认、提供凭证并授权真实模型运行后执行
pnpm crosscheck run --project E:/my-test-project --environment local --module M --case M-TC-1
pnpm crosscheck run --project E:/my-test-project --resume
pnpm crosscheck run --project E:/my-test-project --resume <runId>
# 离线，不需要模型 key、当前画像或目标服务
pnpm crosscheck report <runId> --project E:/my-test-project
# 仅显式选项打开系统浏览器；默认不会打开
pnpm crosscheck report <runId> --project E:/my-test-project --open
```

重复 module/case 各自成集合，两类取交集；未知/空选择不全绿。退出0全PASS，1含FAIL，2不确定/阻断/空/中断/参数错误，3宿主错误优先。report退出0仅说明重建成功，历史业务状态不变。SIGINT/SIGTERM 触发取消，等待资源关闭与工件落盘后退出。

## 离线报告与能力边界

同一保存 RunResult 生成 `.crosscheck/runs/<runId>/results.json`、`junit.xml`、`report/index.html`。报告从历史展示快照与提交点重建，不读当前条款/画像；证据路径、归属、引用、hash 必须通过。HTML 纯静态，无脚本/fetch/CDN；采集 HTML/SVG 转义为文本。JUnit FAIL 为 failure，其他非PASS为 skipped，并保留原状态。未定价/失败缺usage的费用是未知，不是0。

**计划2不含浏览器工具**：WebSocket 无法发送前可靠阻断，因此不支持页面操作验收；screenshot/dom、form/replay、token storage 用例在副作用前 BLOCKED。报告保留已保存 PNG 的静态渲染能力，本阶段 run 无截图时明确“无截图证据”，不伪造图片。

HTTP fixture 只接受固定 JSON 请求与完整 JSON 响应；start/stop 仅有限时、一次性、退出0并输出JSON的批准适配命令，不管理常驻服务。PostgreSQL 只接受完整 TCP URL，限制见指南，执行器只读；真实PG与厂商联调尚未执行。测试只替换外部模型，真实 loopback HTTP/证据/runner/报告均参与，但不代表真实模型质量指标已达标。

## 包与依赖方向

| 包 | 职责 |
|---|---|
| `@crosscheck/core` | schema、受控存储、人工确认、门禁、策略、预算与合议 |
| `@crosscheck/models` | provider/角色解析、重试备用、真实用量 |
| `@crosscheck/agent` | 代理循环、证据附件和输出门禁 |
| `@crosscheck/tools` | 受控HTTP、只读PG、认证/夹具宿主适配与脱敏采证 |
| `@crosscheck/runner` | 已确认输入执行、盲审、资源清理、提交与恢复 |
| `@crosscheck/report` | 已验证历史数据的JSON/JUnit/静态HTML派生 |
| `@crosscheck/cli` | 本地run/report、信号与退出码 |

core/models/agent 不反依赖 report/CLI。构建固定 esbuild 0.28.2，内部 workspace bundle、真实第三方依赖外置，生产入口不含 ai/test 或测试控制。构建输出 dist/node_modules/临时工件不提交。

- 设计说明：`docs/specs/2026-11-12-v1-design.md`
- 实施计划：`docs/superpowers/plans/`
