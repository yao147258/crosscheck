# 手工接入与本地验收

本指南面向**已经启动、已准备测试数据、手工配置且经人确认**的项目。也可使用 init、需求提取、用例生成及交互审核；生成内容仍须人工确认。不要把生产环境作为首次接入目标。真实模型调用需要用户提供全局模型配置、目标测试环境及授权。

## 1. 安装与构建

在 Crosscheck 仓库根目录执行，需要 Node >=22.12、pnpm 9。内部 workspace 被 bundle，真实第三方运行依赖仍由 pnpm 安装；不能单独拷贝一个 JS 就声称独立分发。

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm crosscheck --help
pnpm --filter crosscheck exec crosscheck --help
node packages/cli/dist/index.js --help
```

浏览器执行使用运行时依赖 Playwright 的 Chromium，安装命令为 `pnpm --filter crosscheck exec playwright install chromium`。HTTP-only 用例不要求启动 Chromium。必须在 Crosscheck 仓库构建后运行 `packages/cli/dist/index.js` / `pnpm crosscheck`，不依赖隐式 TypeScript loader。仅用于可信测试环境：标准浏览器没有网络隔离，普通页面自身请求、重定向、WebSocket/WebTransport/WebRTC 正常运行；不安装强制代理，不承诺阻断页面访问其他目标。HTTP/DB 工具的现有守卫不变。

以下示例假设用户自己启动了 `http://127.0.0.1:3000` 测试应用，`GET /health` 返回成功，`POST /api/action` 改变状态，`GET /api/item` 返回完整 JSON `{ "status": "done" }`。服务不存在时必须先人工提供适配，Crosscheck 不会替用户启动未知系统。

## 2. 生成笔记与画像，或手填配置

自动接入可在项目目录使用以下流程（也可为每条命令添加 `--project E:/my-test-project`）。先按下文配置全局模型；首次 `init` 若缺少项目配置，会写入 `.crosscheck/config.yaml` 模板并退出 2，需检查、补充配置后重跑。

```powershell
crosscheck init
# 查看并按需编辑 .crosscheck/notes.md，人工审核确认
crosscheck review notes
crosscheck profile --openapi openapi.yaml
crosscheck review profile
crosscheck reqs --module M
crosscheck review clauses --module M
crosscheck plan --module M
crosscheck review cases --module M
crosscheck run --module M
```

`init` 只生成项目笔记草稿，不再生成画像。`profile` 要求笔记存在且已确认，结合该笔记与结构化事实扫描生成 `.crosscheck/system/` 的七份画像草稿；`--openapi` 可重复，省略时使用默认候选文件。旧用法 `init --openapi <文件>` 应迁移到 `profile --openapi <文件>`。画像、条款和用例仍需人工审核；`plan` 要求七画像与相关条款已确认，`run` 还要求用例确认及凭证、网络授权等执行门禁。

已确认笔记默认在 `init` 时跳过；`init --refresh` 强制重新生成，并将旧笔记提供给模型以尝试合并人工补充，不保证完整保留，结果须人工核对并重新确认。未确认或修改后失效的笔记直接重跑 `init` 会覆盖；编辑笔记后也须重新 `review notes`。旧项目已有画像和有效确认不受影响，但运行 `profile` 前仍须补生成并确认笔记；已确认画像在重跑时跳过。

扫描是预算内的最佳努力，不保证扫描整个项目或完整摘录：内置忽略、文件数量与大小、目录深度及摘录预算等均可能造成遗漏。项目扫描仅处理根目录 `.gitignore` 的有限子集，不保证支持子目录规则、`**` 或取反语义；按有限名称及扩展名规则忽略常见凭证文件，`.env.example` 是例外，无法识别非标准凭证文件，因此可能扫描本应忽略的非标准秘密。脱敏使用有限规则，不能保证识别所有秘密。文件名、摘录、已确认笔记和其他相关内容可能发送给配置的模型服务；运行前应检查内容和服务授权，分享生成物前须人工检查。

也可不使用生成流程，按以下步骤手工准备配置、七画像、条款和用例。

在用户主目录创建 `~/.crosscheck/config.yaml`，以下模型 ID、URL 和密钥均为占位示例，必须替换。此文件包含明文模型密钥：不要提交、共享或粘贴到日志；POSIX 系统应限制目录和文件权限（例如 `chmod 700 ~/.crosscheck && chmod 600 ~/.crosscheck/config.yaml`），Windows 应由用户自行设置文件 ACL，程序不会自动提供 ACL 保护。现有全局文件不会被自动创建或覆盖。

```yaml
models:
  extractor: custom:extractor
  planner: custom:planner
  executor: custom:executor
  reviewer: custom:reviewer
  fallback: {}
providers:
  custom:
    type: openai
    baseURL: https://example.test/v1
    apiKey: 替换为实际密钥
capabilities: {}
pricing: {}
```

全局配置是唯一模型配置来源；项目中旧的模型配置不迁移、不覆盖全局配置。每个模型引用的 provider 名称（包括 openai、anthropic）必须在 `providers` 显式声明；名称可自定义，但 `type` 只能是 `openai` 或 `anthropic`。每项均需填写 HTTP(S) `baseURL`，不得包含 URL 用户名或密码；使用模型时还需非空 `apiKey`。仅备用模型缺密钥会跳过并警告，配置结构错误不会跳过。

升级时须手动修改旧全局配置：将不再支持的 `google`、`deepseek`、`ollama`、`openai-compatible` 类型改为目标服务实际支持的 `openai` 或 `anthropic` 协议，补齐 provider 声明、地址和密钥；不能仅凭类型改名假定兼容。`openai` 使用 OpenAI Responses API，`anthropic` 使用 Anthropic Messages API；仅兼容旧版 Chat Completions 的服务不兼容 `openai` 类型。请确认服务支持对应协议，无法支持时需更换服务。运行开始时固定配置；仅轮换密钥不会改变恢复指纹，其他公开模型配置变化会阻止不兼容的 resume。离线报告和审核不需要全局模型密钥。

### 聊天请求诊断

聊天模型请求默认记录到 `%USERPROFILE%\.crosscheck\chat-requests.jsonl`，包含 SDK 交给 fetch 的方法、地址、请求头和请求体；查询参数全部省略，已知模型密钥和常见认证字段会脱敏。底层网络层自动添加的请求头及重定向后的请求不在记录范围内。

**请求体可能包含对话历史、项目摘要或其他敏感数据，脱敏不能保证识别所有秘密。** 不要随意分享日志；排查完成后建议删除日志。Windows 用户应自行限制日志文件的访问权限。

在被测项目创建 `.crosscheck/system`、`.crosscheck/requirements`、`.crosscheck/cases`。项目配置和其他工件不要写模型密钥。以下各代码块分别保存为标注文件。

项目 `.crosscheck/config.yaml`

```yaml
defaultEnvironment: local
budget:
  perCase: { steps: 30, tokens: 100000, minutes: 5 }
requirementsDocs: []
```

图片配置键是**完整模型 ref**（provider:model），不是角色或裸型号；备用模型也要单独声明。每次实际候选重新装配附件，缺省 `images:false`；截图路径/ID 不代表模型看过图，无图候选不能对要求 screenshot 的预期伪造 PASS/FAIL。只为确认支持图片的型号配置 true，不是给任意型号自动增加视觉能力。

未登记模型价格时 cost 为 null，显示“未知”，不是 0；失败尝试没有 usage 也不能推算费用。推荐执行/复核使用不同厂商；同源会记录独立性低可靠提示，假模型测试不证明厂商质量。

`.crosscheck/system/environments.yaml`

```yaml
version: 1
environments:
  local:
    baseURL: http://127.0.0.1:3000
    healthcheck: http://127.0.0.1:3000/health
    reset: null
```

`.crosscheck/system/auth.yaml`

```yaml
version: 1
actors:
  guest: { kind: anonymous }
  apiUser:
    kind: token
    env: TEST_API_TOKEN
    inject: { kind: header, name: Authorization }
```

`TEST_API_TOKEN` 值需含服务所需完整前缀（例如 `Bearer ...`）。token 也支持 `{ kind: cookie, name: sid }` 或 `{ kind: storage, storage: local, name: access_token }`（storage 可选 local/session）。storage 仅在环境 baseURL 的精确 origin 注入，不自动转换为 HTTP 认证头。

form/replay 消费已人工批准动作，不实现录制，例如在 actors 中追加如下配置，并将用例 actor 改为 member：

```yaml
  member:
    kind: form # replay 使用相同受限动作格式
    environment: local
    actions:
      - { kind: goto, url: /login }
      - { kind: fill, selector: 'input[name=username]', env: TEST_USERNAME }
      - { kind: fill, selector: 'input[name=password]', env: TEST_PASSWORD }
      - { kind: click, selector: 'button[type=submit]' }
      - { kind: waitFor, selector: '#logged-in' }
```

reset→其他夹具→认证顺序固定。缺失普通夹具的现场 browser prepare 使用独立惰性会话，准备完成后关闭，再建立 actor 身份；准备过程中应用自动设置的 cookie、local/sessionStorage、页面登录态不继承到执行，也不重放造数动作。form/replay 的 `environment` 必须与选中运行环境一致，错配由 preflight 阻断，不启动服务、健康检查、夹具或认证动作。浏览器与 HTTP 共享当前 actor：HTTP facade 仅对 baseURL 同 origin 读取浏览器 cookie；header/command/token header 仅向主 page 的同 origin 请求注入，不承诺弹窗、iframe、worker 的头认证覆盖。浏览器原生 cookie 按 domain/path/secure 等规则发送，**cookie 不按端口隔离**，同主机其他端口可能收到它；header/storage 的精确 origin 范围不能被解释为 cookie 网络隔离。不同用例不复用上下文，恢复建立新会话。

`.crosscheck/system/api-catalog.yaml`

```yaml
version: 1
operations:
  action:
    environment: local
    method: POST
    path: /api/action
    description: 将测试条目状态置为完成
    knowledge: [仅用于已授权隔离测试条目]
    sources:
      - { file: 需求.md, line: 1, excerpt: 操作后接口返回完成状态 }
  item:
    environment: local
    method: GET
    path: /api/item
    description: 查询测试条目的状态
    knowledge: []
    sources:
      - { file: 需求.md, line: 1, excerpt: 操作后接口返回完成状态 }
```

`.crosscheck/system/pages.yaml`

```yaml
version: 1
pages: {}
```

`.crosscheck/system/data-model.yaml`

```yaml
version: 1
queries: {}
```

`.crosscheck/system/fixtures.yaml`

```yaml
version: 1
fixtures: {}
```

`.crosscheck/system/guardrails.yaml`

```yaml
allowedHosts: ["127.0.0.1:3000"]
forbidden:
  - { method: DELETE, path: "/**" }
redactFields: [phone, email]
# 可选：批准的 CSS 遮罩；旧配置可完全省略此键
screenshotMasks: ['[data-private]', '.customer-details']
```

HTTP 工具允许主机精确含端口，重定向每跳发送前检查禁止终点；这些策略**不约束浏览器页面自身流量**。允许的 POST/浏览器点击仍会真实修改测试状态，不提供业务回滚或 OS 沙箱。`screenshotMasks` 是 optional 而非默认空数组，省略不改变旧画像审批哈希；添加/修改 selector 后必须重新审阅确认画像。

## 3. 条款与用例

`.crosscheck/requirements/M.yaml`

```yaml
- id: M-AC-1
  text: 对测试条目调用操作接口后，查询接口返回 status 为 done。
  source: { file: 需求.md, line: 1, excerpt: 操作后接口返回完成状态 }
  status: active
  notes: 仅隔离测试数据；不覆盖页面交互。
```

`.crosscheck/cases/M.yaml`

```yaml
- id: M-TC-1
  covers: [M-AC-1]
  fixtures: []
  actor: guest
  steps:
    - POST /api/action 执行已授权测试操作
    - GET /api/item 查询状态
  expectations:
    - id: E1
      text: 操作接口返回成功状态
      evidence: [network]
    - id: E2
      text: 查询接口 JSON 中 status 为 done
      evidence: [network]
```

用例需显式声明所需证据：HTTP 用 network、查询用 db；浏览器用例可声明 `[screenshot, dom]`。例如将上述用例改为页面测试时，同时修改条款原文/出处、步骤为“导航 /form，填写已授权测试数据，点击保存，观察成功提示”，预期为“页面显示保存成功”，证据为 `[screenshot, dom]`，然后重新人工确认，不能只改证据类型却仍按 HTTP JSON 要求判断。

模型通过 `browser_action` 使用 navigate/fill/click/select/press/wait/observe；定位器支持 css/role/text/testId/xpath，fill 的 `value` 与 `env` 二选一，敏感信息只用 env 引用。没有 evaluate/shell/宿主文件路径。每动作前后采集当前视口 PNG 和安全 DOM，密码/敏感字段、填写值、已知秘密、批准 selector，以及 iframe/canvas 等不可可靠核验区域被遮罩/省略；控件值不暴露给模型，不能根据隐藏值断言实际填写内容。请断言可见成功提示或另取允许的业务观察。

截图的源完整性由可信采集器随 PNG 登记为证据索引的可选布尔字段 `sourceIncomplete`，不能由模型或截图输入对象自签，也不通过 summary 字符串传递。批准遮罩、不可核验区域、局部/节点超限等源省略为 true；普通控件的 `redacted-value` 仅表示已批准值脱敏，不视为业务区域缺失。读取后该状态进入实际模型呈现与判定门禁，截图-only 也不能凭不完整截图作 PASS/FAIL；旧截图缺少字段表示 unknown，保守视为不完整，仍可核验/查看，不伪称完整。截图只覆盖当前视口，不是整页、所有滚动位置或动画期间的一致性证明；选择器不能保证识别未知秘密。网络证据仅 URL/方法/状态等有界元数据，正文/头/cookie 源头省略，不足以证明完整业务响应；DOM 被省略/截断或图片未呈现也不能伪造完整证据。采证先在内存脱敏再落盘，不保存原始 HAR/trace/storageState；报告无截图时明确“无截图证据”，不放占位图。自动脱敏不是绝对无泄漏承诺，分享前人工检查。

## 4. 人工审阅与独立确认

先逐项核对七画像全部内容、主机端口、禁止规则、模型与预算、条款原文出处、用例副作用、预期和证据。确认不是 run 的行为，也不能靠重新确认条款恢复旧 case 绑定。

仓库提供独立、可阅读脚本 `scripts/manual-approve.ts`。它调用 `loadProfile` 得到解析后七画像，再 `Approvals.approve('profile', ...)`、`approve('clause', ...)`，最后对每个用例调用 **`approveCase(tc, clauses, by)`** 绑定 covers 条款内容，而不是直接 approve 原始用例。不要将脚本加入 run、CI 自动确认或绕过人工审查。该示例批量确认当前全部输入；若只同意部分，应修改/另写脚本按 ID 选择，不确认其他项。

```powershell
# 构建独立人工脚本，不进入生产 CLI bundle
node scripts/build.mjs --approval
# 只有人工实际逐项审阅后才执行；参数是人工明确确认，不是自动审核
node packages/cli/dist/manual-approve.js E:/my-test-project 审核人 我已逐项审阅并确认
```

脚本不访问服务、不调用模型。修改条款/用例/画像后原确认失效；改条款后需重新审阅相关用例并再次 approveCase。执行中输入固定内存快照，下一次 resume 重新验证所有来源和执行策略 fingerprint；不兼容即拒绝。

## 5. 用户授权后的真实运行

模型密钥按上文填写全局配置；被测系统身份凭证仍使用环境变量，不要把含真实密钥的命令提交。离线 report 不需要模型 key。

```powershell
# 只有使用 apiUser 时需要；完整值由测试环境决定
$env:TEST_API_TOKEN = 'Bearer <用户本地提供>'
pnpm crosscheck run --project E:/my-test-project --environment local --module M --case M-TC-1
# 多次 module/case 各自取集合，两类筛选取交集；未知或空选择不是通过
pnpm crosscheck run --project E:/my-test-project --module M --case M-TC-1 --resume
pnpm crosscheck run --project E:/my-test-project --resume <runId>
```

`--resume` 不带值选择最新兼容的未完成运行，带 runId 指定历史运行。complete 的 PASS/FAIL/DISPUTED/UNCLEAR/业务 BLOCKED 都不会重放。incomplete 使用新 attempt；先前业务动作可能已经发生，不能声称取消会回滚，reset/fixture 幂等性由接入者审查。

Ctrl+C/SIGTERM 只触发 AbortController；CLI await 工具清理、trace/index/result/summary 与报告后设置 exitCode，不强制 process.exit。Windows CI 使用 IPC 验证等价取消；原生终端 Ctrl+C/控制台事件传递仍依实际启动器而异。

退出码：0 全 PASS；1 含 FAIL（疑似 bug，待人工复核）；2 其余、空、阻断、恢复拒绝、中断或参数错误；3 宿主存储/锁/工具/清理/报告错误，优先于业务结果。无 result 的失败不伪造 PASS。report 成功退出0只表示离线报告重建成功，不重写原业务状态。

## 6. 离线报告

```powershell
pnpm crosscheck report <runId> --project E:/my-test-project
# 只有显式 --open 才尝试打开系统默认浏览器
pnpm crosscheck report <runId> --project E:/my-test-project --open
```

工件在 `.crosscheck/runs/<runId>/`：`input.json`（来源/策略 fingerprint 与脱敏展示快照/digest）、`manifest.json`、`cases/<caseId>/attempts/<n>/`（证据、trace.jsonl、models.json、result.json）、`results.json`、`junit.xml`、`report/index.html`。报告可直接 file 打开，无 fetch/CDN/脚本；采集 HTML/SVG 仅转义显示，PNG 验 hash 后静态内嵌。路径、归属、引用、结果 schema、快照 digest 与真实文件 hash 损坏则拒绝，不用模型修补。

报告不读当前 requirements/cases/system/config；删除这些文件也能解释历史快照。不要删除旧 run 的 input、manifest、证据、trace 和结果。复制离线报告可单独分享 HTML 的已嵌入内容；JSON/JUnit 另行提供。分享前人工检查其中的业务敏感内容，自动脱敏不等同绝对无泄漏。

JUnit FAIL 为 failure，其余非 PASS 为 skipped，并保留原状态属性；不能把 DISPUTED 看作测试通过。预算、双方判断、低可靠、夹具建议和漂移保留，漂移不改业务结论。

## 7. 可选 PostgreSQL 与准备适配

无需数据库时保留上述 `queries: {}`，不设置连接变量。只有得到用户指定数据库与授权后才启用，例如替换 data-model：

```yaml
version: 1
connection: { kind: postgres, env: READ_DB_URL }
queries:
  item:
    sql: SELECT status FROM acceptance_items WHERE id = $1
    parameters:
      - { name: itemId, type: string, nullable: false }
```

`READ_DB_URL` 必须完整 TCP URL：`postgresql://reader:非空密码@指定主机:5432/数据库?sslmode=verify-full`（需正确 URL 编码密码）。默认 verify-full；显式 `sslmode=disable` 仅限人工接受的隔离环境。不支持省略账号/密码/库、Unix socket、文件证书 query、其他 query、PG 环境回退或 multi-host URL。服务端账号必须只读且无超级用户/建库/建角色/复制/bypassrls 等特权；执行器用只读事务与保守 SELECT 验证，业务数据库写入禁止。本轮真实 PG 未执行，不能视为已经部署验证。

HTTP fixture 仅引用已批准 operation、固定 JSON body；返回需成功且为完整、未截断 JSON，非 JSON/省略或截断直接 BLOCKED，不 fall back 造数。fixture 所引用 operation 不能依赖 actor，准备发生在认证前。不把 preparation 证据当业务通过依据。

reset 是显式 fixture 名或 null。准备阶段 SQL fixture 只能用独立准备连接和已批准具名 SQL/固定参数，绝不能复用只读连接身份；只在宿主准备阶段可达，执行模型无准备连接或写工具。首次接入推荐 reset:null 和无 fixture，由用户手工准备已知数据；缺失普通 fixture 的现场造数会记录低可靠和补充夹具建议，需人工审查。

start/stop 是可选的批准**一次性 JSON 适配命令**：`{ program: '<可执行文件>', argv: ['参数'], env: { CHILD_ENV: 'HOST_ENV' } }`，无 shell，限时、退出0且 stdout 为合法 JSON（可 `{}`）。不是启动/管理前台常驻服务的接口。只有本 case start 成功才配对一次 stop；stop 用独立有界 signal，失败宿主错误3。可信适配器自己脱离进程树无法保证回收，不提供 OS 沙箱/Job Object 承诺。

## 准备证据与动态身份安全边界

- `command` actor 的动态凭证在认证前尚未知晓。此阶段（含 start、health、reset、已知/现场夹具、认证日志）**所有证据载荷在写入前省略**，只保存宿主生成的 ID/归属及固定省略信封；不写原载荷或原文临时文件。相关动作轨迹也省略输入/输出。认证成功且秘密登记完成后才开放正常业务采证；不会回填旧证据，旧信封明确不完整，digest 始终对应实际保存字节。认证失败、取消或已知夹具失败同样不保存未知载荷。
- 这是保守能力收窄：`command` actor 依赖准备期 HTTP 响应 JSON 变量的已知 fixture 会 **BLOCKED**，因为省略信封不能供变量提取；需要普通 missing fixture 的 HTTP 现场准备也会因证据不完整而 **BLOCKED**，不会提前认证或静默宣称准备成功。可改用已批准且不依赖响应载荷的 command/SQL fixture，或使用可预登记凭证的 token actor；不得为了绕过门禁把秘密写入画像。
- 普通 missing fixture 的准备 `finish` 输出为 `{ "prepared": true, "evidenceIds": ["宿主HTTP证据ID"] }`。必须引用本次现场准备窗口内、当前 attempt、hash 已核验且来源完整/响应成功的真实 HTTP 观察；health、已知 fixture 日志、业务证据或模型陈述均不能替代。缺失/无效凭据在同一个 agent 循环累计最多三次修正后 BLOCKED，不认证、不执行业务。凭据只证明前置状态声明有真实观察，不是条款判定，不送独立 review。
- DB 业务依据必须是生产顶层 `status: success`、`sent: true`、`rows` 数组且 `truncated: false` 的完整查询信封。blocked/连接失败/timeout/cancelled 等事件仍保留审计，但以来源不完整呈现并排除 required 业务查询集合，不能满足 pass/fail 业务证据门禁；不解释 rows 内同名业务字段。unclear 可无证据，有引用仍核验归属/hash/呈现完整性。
- 最终 reasoning/reason/建议/漂移/可靠性错误统一按 JSON 与明确 URL 语义清洗，再清洗已知秘密；可信 usage/budget 数字不作通用 token 键脱敏。证据读取后的正常取消返回中断/预算，不标记宿主故障；真实读取/verify 异常即使同时取消仍为宿主错误，不 retry/fallback。

## 当前验证边界

2026-11-16 恢复交付标准 Chromium 自动操作（覆盖 2026-11-13 暂缓历史）：真实 loopback 表单、scripted 模型、构建后的 CLI 子进程、执行/盲审 PNG 与 DOM 附件、PASS/DISPUTED/无图 BLOCKED、证据归属/hash、JSON/JUnit/HTML 与静态 file 报告均有自动验证。不消耗外部模型 token。取消/清理、预算、认证/恢复复用已有 runner/tools 测试覆盖，不意味着生产环境、任意网页或完整网络隔离已验。

```powershell
pnpm typecheck
pnpm build
pnpm test # 默认跳过 CROSSCHECK_REAL_BROWSER 门控组，不能据此称真实浏览器已验
$env:CROSSCHECK_REAL_BROWSER = '1'
pnpm vitest run packages/cli/test/browser-e2e.test.ts --maxWorkers=1 --testTimeout=15000
pnpm vitest run --maxWorkers=1 --testTimeout=15000
Remove-Item Env:CROSSCHECK_REAL_BROWSER
```

真实 PG、厂商模型联调、质量/召回率/误报率本轮未执行。最低 Node 22.12 的 CLI 冒烟是之前历史，本轮未在该最低版本重验浏览器链路；当前机器通过不等于最低版本验证。
