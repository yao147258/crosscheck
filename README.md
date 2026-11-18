# Crosscheck

面向**已启动、手工配置并经人确认的可信测试项目**的本地 Chromium 浏览器 / HTTP / 可选 PostgreSQL AI 验收工具。AI 可自动操作页面、采集脱敏证据，再由执行器与独立 reviewer 双判；FAIL 是疑似 bug，待人工复核。浏览器无网络隔离，不适用于不可信页面或生产环境。

## 构建与使用

需要 Node.js >=22.12 和 pnpm 9。Node v22.12.0 构建 CLI 冒烟是此前历史验证，本轮浏览器交付未重跑最低 Node；第三方依赖仍需安装，不是单文件独立分发。

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm build
# 需要浏览器操作或真实浏览器测试时安装 Chromium；HTTP-only 不启动它
pnpm --filter crosscheck exec playwright install chromium
pnpm crosscheck --help
# 同一个本地 bin（从仓库运行）
pnpm --filter crosscheck exec crosscheck --help
```

发布到 npm 后也可全局安装为系统命令：`npm i -g crosscheck`，之后在任意目录直接运行 `crosscheck --help`。

可使用 `init → reqs → review → plan → review → run` 流程，也可阅读 [完整手工接入指南](docs/manual-integration.md) 手工准备七画像、条款与用例；该指南中的独立 approveCase 脚本仍可用。生成命令只写草稿，不会自动确认；`run` 仍要求人工确认与凭证、网络授权等门禁。尚无 npm 发布或 npx 可用承诺。

| 命令 | 用途 |
|---|---|
| `init [--openapi <文件>]...` | 缺少配置时写 `.crosscheck/config.yaml` 模板并退出 2；配置完成后扫描项目并生成七份画像草稿 |
| `reqs --module <id>` | 从配置的 `requirementsDocs` 提取带来源的条款草稿 |
| `review [profile\|clauses\|cases\|results]` | 交互审核画像、条款、用例与运行结果；支持 `--module <id>`、`--run <runId>` 定位 |
| `plan --module <id>` | 画像全部确认、条款确认后，生成用例草稿 |
| `run` / `report <runId>` | 执行已确认用例 / 从历史快照离线重建报告 |

无参数运行 `crosscheck`（stdin 和 stdout 均需 TTY）进入常驻会话。输入 `/init`、`/reqs`、`/plan`、`/review`、`/run`、`/report`、`/help`、`/clear` 或 `/exit`；参数与独立命令相同，含空格的路径用引号包围，例如 `/review cases --project "E:/my project"`。输入以 `/` 开头时输入框下方显示匹配命令与描述，Tab 在匹配命令间循环补全。`/clear` 清空对话消息与模型历史。每次进入审核都会重新读取对应项目的确认记录，`q` 或顶层 `Esc` 返回聊天。命令执行失败只显示退出码，不结束会话。运行中 Ctrl+C 请求取消并等待清理；空闲时使用 `/exit` 退出。

普通文本使用当前工作目录项目的 `planner` 模型配置和当前磁盘摘要（待审核画像、条款、用例和运行次数），无需确认人身份；聊天模型没有工具或确认权限，不能修改项目。模型配置或摘要读取失败会显示错误，其他命令仍可使用。聊天历史仅保存在内存中。带参数的一次性 CLI 及其退出码保持不变。

模型的四个角色、`providers`（含明文 `apiKey`、`baseURL`）、`capabilities` 和 `pricing` 配置于用户级 `~/.crosscheck/config.yaml`；每个引用的 provider 必须显式声明，类型仅支持 `openai` 和 `anthropic`，且必须提供不含用户凭据的 HTTP(S) `baseURL`。`openai` 使用 Responses API，不兼容仅支持旧 Chat Completions 的服务。项目 `.crosscheck/config.yaml` 只负责预算、`requirementsDocs` 与默认环境，不能覆盖模型配置。文件格式、权限及安全注意事项见[手工接入指南](docs/manual-integration.md)。程序不会自动覆盖全局文件或迁移旧项目；报告和审核可离线运行。全局密钥为明文，务必限制文件权限并避免分享；POSIX 可使用 `chmod 600`，Windows 须自行配置 ACL。

各命令支持 `--project <目录>`。重跑生成命令保留仍有效的已确认条目；中断丢弃尚未写盘的合成草稿，保留已经完整写入的文件，不承诺跨文件事务回滚。

`review` 要求 stdin、stdout 都是 TTY，管道/重定向环境拒绝并退出 2。确认人优先取去除首尾空白后的 `CROSSCHECK_REVIEWER`，否则取系统用户名；无法确定时退出 2。编辑器依次取 `VISUAL`、`EDITOR`，支持双引号参数且不经过 shell；未设置时显示提示。外部编辑器通过 Ink 暂停 TUI 后启动，结束或出错后恢复；已在 Windows ConPTY 验证事件式/同步读入的命令行编辑器交互输入、连续保存与错误恢复，不代表已验收所有平台或原生 GUI 编辑器。`q` 正常退出、`Esc` 返回（初始视图退出），退出码 0；`Ctrl+C` 中断退出 2。写操作期间键盘退出会提示等待；外部 signal、SIGINT/SIGTERM 取消则等待当前操作结束后退出 2，不截断写盘。查看原始截图证据当前不支持；打开文本只请求系统启动，不保证宿主程序已显示。

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

**2026-11-16 当前能力**：标准 Playwright Chromium 支持 `browser_action` 的 navigate/fill/click/select/press/wait/observe；每用例独立上下文、惰性启动，结束/取消时等待关闭。2026-11-13 因 WebSocket 准入暂缓的裁定保留在计划历史，已被用户后续“取消浏览器网络隔离、恢复自动测试”覆盖。普通页面请求、重定向、WebSocket/WebTransport/WebRTC 正常运行，不安装强制代理或网络准入拦截；`allowedHosts/forbidden` 仍约束 HTTP 工具，不覆盖页面自身流量。模型没有 evaluate、shell 或宿主文件能力。

截图/DOM、console 和网络元数据先脱敏再落盘；网络不保存完整正文、头或 cookie，不能作为完整响应断言。`guardrails.screenshotMasks` 为可选 CSS selector 数组（省略时保持旧确认哈希；更改后需重新人工确认）。模型图片能力必须按完整 ref 配置，例如 `capabilities: { 'openai:your-executor-model': { images: true }, 'google:your-reviewer-model': { images: true } }`，备用模型也逐项配置；缺省无图，不能满足 screenshot 预期则 BLOCKED/UNCLEAR，不伪造 PASS。form/replay 和同 origin storage token 已接入，认证与遮罩局限见手工指南。

```powershell
# 默认测试会跳过显式 real 浏览器组；以下才运行真实浏览器且不调用外部模型
$env:CROSSCHECK_REAL_BROWSER = '1'
pnpm vitest run packages/cli/test/browser-e2e.test.ts --maxWorkers=1 --testTimeout=15000
pnpm vitest run --maxWorkers=1 --testTimeout=15000
Remove-Item Env:CROSSCHECK_REAL_BROWSER
```

真实 CLI 用例通过构建 JS 入口（无隐式 TypeScript loader），脚本模型驱动真实 loopback 表单并核验双方 PNG/DOM 附件、报告与脱敏；不证明厂商模型质量。截图是当前视口，不保证滚动页/动画的全局一致性；控件值已脱敏，不能据隐藏值断言输入内容，未知秘密仍需人工检查。

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
| `crosscheck`（内部包名曾为 `@crosscheck/cli`） | init/reqs/plan/review/run/report、信号与退出码 |
| `@crosscheck/tui` | 交互审核、人工确认与运行结果裁决 |
| `@crosscheck/planner` | 基于已确认画像、条款生成用例草稿 |
| `@crosscheck/discovery` | 只读提取本地项目与 OpenAPI 事实候选 |
| `@crosscheck/requirements` | 从调用方提供的文档中提取可追溯的需求条款草稿 |

## 项目发现

```ts
import { discover, openApiPlugin, staticScanPlugin } from '@crosscheck/discovery';

const result = await discover({
  projectRoot: '/path/to/project',
  plugins: [staticScanPlugin, openApiPlugin(['openapi.yaml'])],
});
console.log(result.facts, result.diagnostics);
```

发现只读取项目内允许的本地文件，不执行发现的命令，也不访问网络。输出是待审核的事实候选，不是网络访问授权；文档中的服务器地址不会加入授权列表。插件是受信任的进程内代码，只读接口不是恶意插件的安全沙箱。脱敏采用有限的启发式规则，不能保证清除所有隐私或秘密；来源摘录、文件名和结果仍应谨慎处理。

OpenAPI 支持 3.0、3.1 和 Swagger 2 的本地 JSON/YAML 接口目录，包含参数覆盖、文档内 JSON Pointer、服务器和来源行号；外部引用不读取或请求，无法完整解析的操作会诊断并跳过。不做完整规范校验、认证或 requestBody 建模。含明确用户信息的路径会诊断跳过，普通路径内部的双斜杠保持原样。带引号的内联凭证会保守遮盖到行尾，命令候选不保证仍可执行。Compose 长语法仅接受有效静态 target 和可选 published 端口；变量及无法绑定实际 ports 项来源的结构会诊断跳过。静态扫描的 POM 只支持受限 XML 子集，不展开实体、DTD 或外部内容。

## 需求条款提取

调用方负责选择和配置模型，并显式提供文档文本；`file` 仅是来源标识，服务不会读取该文件。

```ts
import { BudgetTracker } from '@crosscheck/core';
import { extractRequirements } from '@crosscheck/requirements';

// model 由宿主提供，符合已有 ModelCandidate 的模型接口。
const result = await extractRequirements({
  module: 'M01',
  documents: [{ file: 'req.md', text: '用户必须登录' }],
  models: [{ ref: 'provider:model', model }],
  budget: new BudgetTracker({ steps: 10, tokens: 10000, minutes: 1 }),
});

if (result.status === 'done') {
  const drafts = result.output; // 仅为草稿，交由人工审核
} else {
  console.log(result.reason, result.detail);
}
```

服务不提供文件、源码或网络工具，也不会保存或确认条款。来源文件、行号与摘录的匹配校验不能证明条款语义正确，草稿仍需人工审核。返回的 `messages` 可能包含需求内容，不应自动写盘或视为公开日志。文档长度限制不是模型上下文预算；实际 token 预算由 `BudgetTracker` 和模型用量回执控制。

core/models/agent 不反依赖 report/CLI。构建固定 esbuild 0.28.2，内部 workspace bundle、真实第三方依赖外置，生产入口不含 ai/test 或测试控制。构建输出 dist/node_modules/临时工件不提交。

- 设计说明：`docs/specs/2026-11-12-v1-design.md`
- 实施计划：`docs/superpowers/plans/`
