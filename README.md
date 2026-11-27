# Crosscheck

面向**已启动的可信测试项目**的本地 Chromium 浏览器 / HTTP / 可选 PostgreSQL AI 验收工具，执行前须完成所需的配置与人工确认。AI 可自动操作页面、采集脱敏证据，再由执行器与独立 reviewer 双判；FAIL 是疑似 bug，待人工复核。浏览器无网络隔离，不适用于不可信页面或生产环境。

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

推荐流程：`init → reqs → review clauses → plan → review cases → run`。`init` 一次完成笔记与画像的生成、自动确认和待确认画像的人工审核交接。也可按 [完整手工接入指南](docs/manual-integration.md) 手工准备七画像、条款与用例；指南中的独立 approveCase 脚本仍可用。尚无 npm 发布或 npx 可用承诺。

| 命令 | 用途 |
|---|---|
| `init [--refresh] [--openapi <文件>]...` | 缺少配置时先写入默认 `.crosscheck/config.yaml`；扫描并生成笔记，以 `auto` 自动确认；生成缺少有效确认的画像，按来源核验结果自动确认 `api-catalog`、`pages`；如有待确认画像，stdin、stdout 均为 TTY 时直接进入审核，否则列清单并退出 2 |
| `profile [--openapi <文件>]...` | 单独生成画像草稿，要求笔记已确认；不自动确认。`init` 已包含画像生成，两条命令均可重复传入 `--openapi` |
| `reqs --module <id>` | 优先从 `requirementsDocs`（支持目录）提取带来源的条款草稿；仅配置为空时才使用已确认笔记的“需求文档”小节 |
| `review [notes\|profile\|clauses\|cases\|results]` | 交互审核笔记、画像、条款、用例与运行结果；支持 `--module <id>`、`--run <runId>` 定位 |
| `plan --module <id>` | 画像全部确认、条款确认后，生成用例草稿 |
| `impact [--since <commit>] [--json]` | 只读比较 Git 基线与当前磁盘，列出变更及画像、用例的级联影响 |
| `run` / `report <runId>` | 执行已确认用例 / 从历史快照离线重建报告 |

无参数运行 `crosscheck`（stdin 和 stdout 均需 TTY）进入常驻会话。输入 `/init`、`/profile`、`/reqs`、`/plan`、`/review`、`/run`、`/report`、`/impact`、`/status`、`/usage`、`/help`、`/clear` 或 `/exit`；参数与独立命令相同，含空格的路径用引号包围，例如 `/review cases --project "E:/my project"`。输入以 `/` 开头时输入框下方显示匹配命令与描述，Tab 在匹配命令间循环补全。每次进入审核都会重新读取对应项目的确认记录，`q` 或顶层 `Esc` 返回聊天。命令执行失败只显示退出码，不结束会话。运行中 Ctrl+C 请求取消并等待清理；空闲时使用 `/exit` 退出。

`/status [--project <目录>]` 只读查看推断的项目阶段、待审核数量和最新测试运行；数据缺失、运行未完成或损坏会明确提示。阶段是根据已有工件推断，不代表项目已全部完成。结果待裁决数量仅针对最新运行。

普通文本使用会话启动项目的 `planner` 模型配置和当前磁盘摘要（待审核画像、条款、用例和运行次数），无需确认人身份；聊天模型没有工具或确认权限，不能修改项目。模型配置或摘要读取失败会显示错误，其他命令仍可使用。带参数运行时仍使用独立 CLI，各命令的退出码见相应说明。

**会话历史：** 每次启动默认新建会话。`/sessions` 列出启动项目的历史；`/resume` 不带参数时列出候选和用法，不会自动选择。使用 `/resume <UUID>` 恢复界面历史及有效聊天上下文，沿用原会话的用量 ID。恢复不会请求模型、重放斜杠命令或审核，也不会自动续跑中断的测试；`run --resume` 的行为不变。`/clear` 清空界面和模型上下文并生成新 ID，不删除旧历史或用量；`/exit` 等待写入收尾。

历史记录位于 `~/.crosscheck/projects/<规范项目路径的 SHA-256>/sessions/<UUID>/`，与用量账本共用同一个项目键。存档包含聊天、命令、最终输出和状态，不保存每条进度；恢复界面的最终输出按 UTF-8 最多保留 64 KiB 并标记截断；成功聊天的完整规范化回复另存为模型历史，不受此上限限制。模型只使用最近 20 条有效历史消息，失败聊天、命令及其输出不进入模型上下文。请勿在多个终端同时操作同一个会话。版本冲突会显式报错，不覆盖旧记录，但已执行的操作仍可能因冲突无法归档；发现损坏时提示并保留可读的有效前缀，该会话只读。未完成的操作会标记，不会重放；发现暂存文件会提示，但不会将其视为已提交记录。存储需要文件系统支持同目录硬链接，不支持时会报错。记录文件在硬链接前同步；支持目录同步的平台和文件系统还会同步首次追加的父目录和提交后的会话目录。Windows 上 Node 不支持目录同步；在 Windows 或其他不支持目录同步的文件系统上，不保证突然断电后的目录项持久性。若祖先目录可以穿越但无权同步，仍允许写入会话，并在提交后提示目录项持久性风险。提交后的目录同步错误也会提示风险并保留已提交修订，不重试覆盖。

聊天及存档文本会尽力脱敏（包括可读取的配置密钥），后续模型请求与恢复使用相同的规范化聊天文本，可能改变原文含义。若即将发送的历史命中当前配置密钥，本轮会报错且不调用模型，不改写原历史；可用 `/clear` 开始新会话。命令仍按原参数执行；`/review` 默认审核启动项目，显式 `--project` 可以覆盖。脱敏不能识别所有秘密，哈希也不提供加密。POSIX 下新建目录和记录文件分别使用 `0700` 和 `0600`；Windows 下请自行限制用户目录的 ACL。内置模型的聊天请求默认尝试写入独立的 `~/.crosscheck/chat-requests.jsonl`；请求体可能包含聊天历史和其他敏感内容。恢复或清空不会关闭或删除这个日志。

模型的四个角色、`providers`（含明文 `apiKey`、`baseURL`）、`capabilities` 和 `pricing` 配置于用户级 `~/.crosscheck/config.yaml`；每个引用的 provider 必须显式声明，类型仅支持 `openai` 和 `anthropic`，且必须提供不含用户凭据的 HTTP(S) `baseURL`。`openai` 使用 Responses API，不兼容仅支持旧 Chat Completions 的服务。项目 `.crosscheck/config.yaml` 只负责预算、`requirementsDocs` 与默认环境，不能覆盖模型配置。文件格式、权限及安全注意事项见[手工接入指南](docs/manual-integration.md)。程序不会自动覆盖全局文件或迁移旧项目；报告和审核可离线运行。全局密钥为明文，务必限制文件权限并避免分享；POSIX 可使用 `chmod 600`，Windows 须自行配置 ACL。

各命令支持 `--project <目录>`。`init` 默认跳过已确认的笔记；`--refresh` 重新生成并自动确认笔记，旧笔记作为模型上下文，人工补充不保证保留。未确认或编辑后失效的笔记直接重跑 `init` 也会被覆盖；要保留编辑结果，可先用 `review notes` 人工确认。`init` 和 `profile` 均跳过仍有有效确认的画像，即使 `init --refresh` 也不覆盖这些画像。不带 `--refresh` 重跑 `init` 时，若笔记及七份画像均已有有效确认，不需要模型配置，也不会调用模型，但仍执行最终交叉校验。中断不回滚已完成的写入；文件内容与确认记录虽会复查，但不提供跨进程原子事务。

**审核与退出：** `api-catalog` 或 `pages` 至少有一条通过来源核验且没有来源读取故障时，才剔除未通过项并整份自动确认。没有通过项（包括原本为空）、来源读取故障，或画像引用了未被扫描登记的显式 `--openapi` 文件时，保留该画像原稿并交给人工审核。`/init` 在会话内打开仅列待确认画像的审核界面，退出后返回聊天。独立 `init` 与 `/init` 的筛选审核界面若提示交叉校验未通过，可按 `f` 打开完整画像审核，修正并重新确认原先隐藏的画像。独立 `init` 若还有待确认画像，正常退出审核仍按 `review` 约定返回 0（`q` 或顶层 `Esc`），中断返回 2；可用 `review profile` 继续。独立 `init` 在无需人审或人审正常结束后，若七画像均已确认，会重新校验笔记确认、七画像的格式与交叉引用，并复查画像确认；复查发现笔记缺失、不是有效 UTF-8、笔记或画像未确认或确认失效，或发现必需画像缺失、画像结构或交叉引用不合法时，退出 2。YAML 解析异常等未归入这些检查的错误可能按宿主错误退出 3。

**审核门禁与边界：** 笔记自动确认不保证有人看过；笔记只影响画像生成和需求文档范围，不直接决定测什么。画像来源匹配只说明指定行包含摘录，不证明画像语义正确，也不授予网络或执行权限。`environments`、`auth`、`data-model`、`fixtures`、`guardrails` 始终由人确认；`plan` 仍要求七画像和相关条款已确认，`run` 仍要求用例确认、凭证和网络授权等门禁。`review profile` 和 `/status` 显示有效已确认画像的确认人；`auto` 为自动确认保留，历史同名记录不迁移，无法与自动确认区分。

扫描是预算内的最佳努力，不保证覆盖整个项目：内置忽略规则会排除部分文件，数量、深度、大小和摘录上限也可能导致遗漏。项目扫描仅处理根目录 `.gitignore` 的有限子集，不保证支持子目录规则、`**` 或取反语义；按有限名称及扩展名规则忽略常见凭证文件，`.env.example` 是例外，无法识别非标准凭证文件，因此可能扫描本应忽略的非标准秘密。脱敏采用有限规则，不保证识别所有秘密。文件名、摘录、已确认笔记及相关内容可能发送给配置的模型服务；运行前请检查项目内容和服务授权，分享生成物前也应人工检查。

**需求文档登记：** `requirementsDocs` 可写文件，也可写以 `/` 结尾的目录（如 `docs/prd/`）。目录递归展开 `.md` 文件（不区分大小写），最多下探 8 层子目录，展开后合计最多 100 个文件；不支持 glob，显式文件不限扩展名。显式配置或人工确认笔记沿用原有路径安全和目录跳过规则，目录展开会跳过符号链接、凭证文件以及 `node_modules`、`.git`、`.crosscheck`。`config.yaml` 的 `requirementsDocs` 非空时始终优先；仅为空时，`reqs` 与 `impact` 才读取 `notes.md` 的“## 需求文档”小节（每行 ``- `路径` 说明``）。`reqs` 只使用已确认的笔记；`impact` 只读分析，不要求笔记已确认，也不使用下述自动确认笔记的登记门禁。

当 `reqs` 回退到 `auto` 确认的笔记时，要求 `init` 生成笔记时写入的 `.crosscheck/notes-discovery.json` 与当前笔记匹配。`reqs` 会重新扫描并展开目录，要求文档路径集合与生成时登记一致。目录增删造成候选集合变化、文件未登记、扫描或目录展开不完整、文档不可读时，`reqs` 退出 2，不提交需求正文给提取模型。旧版自动确认笔记缺少记录时，可用 `init --refresh` 重新生成笔记和登记，或审核笔记后用 `review notes` 人工确认，也可在 `config.yaml` 的 `requirementsDocs` 显式登记。`init` 不会把笔记登记写回 `config.yaml`。

`review` 要求 stdin、stdout 都是 TTY，管道/重定向环境拒绝并退出 2。确认人优先取去除首尾空白后的 `CROSSCHECK_REVIEWER`，否则取系统用户名；无法确定或取到保留身份 `auto` 时退出 2。编辑器依次取 `VISUAL`、`EDITOR`，支持双引号参数且不经过 shell；未设置时显示提示。外部编辑器通过 Ink 暂停 TUI 后启动，结束或出错后恢复；已在 Windows ConPTY 验证事件式/同步读入的命令行编辑器交互输入、连续保存与错误恢复，不代表已验收所有平台或原生 GUI 编辑器。`q` 正常退出、`Esc` 返回（初始视图退出），退出码 0；`Ctrl+C` 中断退出 2。写操作期间键盘退出会提示等待；外部 signal、SIGINT/SIGTERM 取消则等待当前操作结束后退出 2，不截断写盘。查看原始截图证据当前不支持；打开文本只请求系统启动，不保证宿主程序已显示。

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

## 模型用量统计

在交互会话内，`/usage` 查看启动项目的累计用量，`/usage --session` 查看当前会话，`/usage --session <UUID>` 查看该项目内指定会话的用量。报告按命令、角色和请求发送时指定的模型分组，不识别服务商在后台改派的模型；会话页头显示当前会话的累计用量。一次性执行 `init`、`profile`、`reqs`、`plan` 或 `run` 也计入项目用量，但不归入会话。`init` 中的笔记请求归入 `init`、画像请求归入 `profile`，每次实际请求只记一条。会话内通过 `--project` 操作其他项目时，用量只记入目标项目，但命令及归档输出仍保存在启动项目的当前会话中。恢复会话后继续使用原 ID 统计；`/clear` 后改用新 ID。此前仅记录到账本、未保存对话的会话仍可凭已知 ID 查询用量，但不能恢复对话。

报告区分已知的输入、输出、缓存读写 token、费用估算及未知调用。内置 OpenAI 和 Anthropic 仅在进入模型适配器的 fetch 时计入账本；SDK 的本地预处理失败不入账，自定义注入模型则以 `doGenerate` 为边界。重试和备用模型分别计入。内置 OpenAI 只采用原始回执中的用量字段：即使响应解析失败，SDK 若暴露了原始回执，仍可记录其中的已知用量；未返回 `cached_tokens` 时缓存读和费用未知，显式零才算已知。费用是按配置价格计算的估算，不是服务商账单。现有运行报告和严格审计的口径独立于账本，不会导入或重复记账；启用前的历史不回填。

账本保存在 `~/.crosscheck/projects/<规范项目路径的 SHA-256>/usage/`。项目以 `realpath` 返回的实际路径为准，能解析到同一路径的符号链接共用账本。Windows 也不强制转小写；若文件系统解析出不同大小写的实际路径，则视为不同项目。无法解析项目时不写账本，并告警。哈希不是加密。账本不存提示词、对话、工具输出或密钥，但模型名等元数据仍可能敏感。POSIX 新建账本目录和文件时分别使用 `0700` 和 `0600`；这些模式在 Windows 上不等价于 ACL，请自行限制用户目录的 ACL。既有 `~/.crosscheck/chat-requests.jsonl` 独立存在，仍可能包含敏感请求内容。

账本写入失败会提示统计不完整，不改变模型或命令已确定的结果。调用完成时先在内存暂存事件，等使用共享预算的业务收尾后再写入。若进程在写入前异常退出，或写入失败且未留下可检测的痕迹，后续查询可能无法发现漏记。损坏或未完整写入的文件会在查询中提示。

## 变更影响分析

```powershell
crosscheck impact --project E:/my-test-project
crosscheck impact --since HEAD~1 --project E:/my-test-project
crosscheck impact --since <commit> --json --project E:/my-test-project
```

`impact`（会话中为 `/impact`）默认比较 `HEAD` 与当前磁盘文件，包括未提交修改和相关新增文件，不单独比较暂存区。按上述优先级读取新旧两侧登记的需求文档，以及笔记、七画像、条款和用例，不扫描整个源码；无需模型配置或 API 密钥，不更改产物和确认状态，也不自动重新生成。

被测项目应将相关需求文档及 `.crosscheck/config.yaml`、`notes.md`、`system/`、`requirements/`、`cases/` 纳入 Git；提交前先检查秘密，不要将凭证、全局模型密钥或运行证据一并加入。基线没有这些输入、文件损坏、引用缺失或超限时会报告分析不完整，不会用空基线冒充“无影响”。

报告区分实际变更、显式依赖影响、可能影响和分析缺口，并提供原因链。`covers`、角色和夹具等显式引用可定位依赖；笔记和自然语言步骤没有完整的细粒度映射，因此保守列为可能影响。“确定影响”表示存在确定的依赖关系，不代表测试一定失败；“未发现关联”也不保证完全无影响。当前版本只建议复核，不自动使已确认下游失效，生成命令仍遵循原有保留规则。

`--json` 输出单个版本化报告对象，不含原文或配置值。`impact` 的退出码独立于运行结果：`0` 为分析完整（即使存在影响），`2` 为无效基线、输入不完整或中断，`3` 为宿主故障。没有 Git 历史时需先人工建立基线；命令不会自动提交或保存快照。为避免 Git 惰性获取触发网络或写入，首版拒绝 partial/promisor 仓库及使用 alternates 共享对象库的仓库，请使用完整且独立的仓库。分析、原因链与报告有资源上限；达到上限时返回不完整报告和退出码 `2`。

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
| `crosscheck`（内部包名曾为 `@crosscheck/cli`） | init/profile/reqs/plan/impact/review/run/report、信号与退出码 |
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
