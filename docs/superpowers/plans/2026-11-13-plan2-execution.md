# 计划 2：真实执行、证据与 run/report 闭环

> **执行方式：** 使用 superpowers:subagent-driven-development 逐任务实现与审查。

**目标：** 交付手工确认输入下可用的真实 run/report 闭环。

**技术栈：** TypeScript、pnpm、Zod、AI SDK、Playwright Chromium、node-postgres。

**规格：** `docs/specs/2026-11-12-v1-design.md` 与 `docs/superpowers/plans/2026-11-12-plan1-followups.md`。

## 执行范围调整（2026-11-13 用户确认）

Task5 浏览器工具暂缓：真实准入验证发现 WebSocket 握手绕过已测 CDP 拦截，不能满足发送前阻断要求。原文保留作为后续恢复范围，本次交付改为 HTTP/可选 PostgreSQL 的 run/report 闭环；不开放未审查的浏览器研究代码，不交付截图/DOM 采集。要求 screenshot/dom 证据、form/replay 认证或 storage token 注入的用例必须在副作用前 BLOCKED，不能静默替换证据标准。最终 CLI 集成验收使用真实 loopback HTTP 工具与假模型，不声称完成真实浏览器闭环。细节见 `2026-11-13-plan2-contracts.md`。

## 全局约束

- 所有对话和文档使用中文，代码注释使用中文。
- core 不依赖其他内部包；模型与真实工具可注入替换，测试不消耗真实模型 token。
- 判定标准只能来自已确认条款；reviewer 不得获得 executor 结论和推理。
- 执行阶段不提供夹具能力；DB 查询工具始终只读；请求必须受 guardrails 约束。
- 凭证只从环境变量取，证据必须先脱敏再落盘；被测项目内只写 `.crosscheck/`。
- 每用例默认预算60步、400000 tokens、10分钟，由各执行阶段共享；代理轮次和模型重试次数分开记录。
- 当前 SDK7/provider4 要求 Node ≥22，交付基线暂为 Node ≥22.12，不宣称 Node20兼容；最低版本实际验证状态需单列。
- 保留用户已有 `.gitignore` 修改；用户未要求时不提交、合并、推送或发布。

## Context

计划 1 已完成 core/models/agent 内核，但尚不能通过 CLI 对真实 Web 项目验收。用户要求继续计划 2。本阶段交付**可在本地对已准备好、已人工确认的项目运行的验收闭环**：真实工具 → 自动采证 → executor 自判 → reviewer 盲审 → 合议 → JSON/JUnit/HTML，并支持用例粒度恢复和中断。

原始依据：`docs/specs/2026-11-12-v1-design.md` §5、§8—12，以及 `docs/superpowers/plans/2026-11-12-plan1-followups.md`。计划 3 仍负责 init/record/reqs/plan、自动发现和 Ink 审核；计划 4 负责 shop-demo、真实模型质量评测和社区治理接入。不把本阶段描述成完整第一版。

## 推荐架构与边界

- 复用现有 `core/models/agent`，新增 `tools`（真实操作与采证）、`runner`（状态机与运行持久化）、`report`（纯渲染）、`cli`（run/report）。依赖方向为 cli → runner/tools/report；runner → agent/models/core；tools → agent/core；report → core。core 不依赖其他内部包。
- 首期浏览器限定 **Chromium**，数据库可选且先支持 **PostgreSQL**；不同时增加其他数据库和浏览器适配。HTTP 支持 guardrails 允许的业务写操作，DB 查询始终只读。
- 提前冻结计划 2 必需的画像消费 schema，计划 3 后续生成同一格式，而不是各自另造协议。
- 默认串行用例，避免 reset/夹具污染；每用例独立浏览器上下文和专属 DB 连接。所有宿主写入限定到被测项目 `.crosscheck/`；已有批准的夹具可以改变测试环境业务状态，不等于可修改项目源码。
- 本阶段提供本地构建后的 CLI 和手工输入接入指南，不承诺已经发布 npm、不宣称可直接 `npx crosscheck`。开发 Node ≥22.12；CLI 最低运行版本必须由实际依赖和最低版本冒烟验证，不仅写 engines。

## 必须固定的行为

### 输入与确认

- `system/` 固定清单：environments、auth、api-catalog、pages、data-model、fixtures、guardrails；无 DB/夹具/认证时使用显式空配置或 `none`，不能因漏读文件跳过确认。
- 环境含基础 URL、健康检查、可选已确认启动/停止命令；命令为可执行文件 + argv，不提供任意 shell。guardrails 的 allowedHosts 是唯一网络授权来源；环境地址也必须通过它。
- auth 按 actor 声明 anonymous/form/token/声明式动作回放/预登记命令；凭证只写环境变量名。回放是消费批准的动作配置，不实现计划 3 的人工录制。HTTP 与浏览器共享同一用例的 actor 身份，账号凭证不进入报告。
- fixture 实现按 command/http/sql 区分；命令、SQL 写凭证仅能在准备阶段使用。保留 `fixtures: string[]`，参数固定在已确认的 fixture 定义中，输出返回结构化上下文供后续步骤使用；不在本阶段增加任意模型模板语言。
- 环境明确配置 reset 策略（具名reset或显式none）；宿主执行一次，随后按用例声明顺序运行其余夹具；数组中重复的 reset 去重。必需reset缺失/失败或已登记夹具失败直接BLOCKED，不能现场猜替代操作；仅缺失的普通夹具允许准备阶段通过受控 browser/http 现场造数，并记录低可靠与建议；失败即 BLOCKED。
- 用例确认绑定 `{case, 所覆盖条款的内容哈希}`。旧版只有自身哈希的 case 确认需要人工重新确认，不能静默升级。提供可复用确认 payload/API 与人工审核脚本示例，不添加自动通过或 `--force`。
- 同一运行内输入快照固定；恢复时重算当前输入/审批指纹，不一致则拒绝恢复，要求新开运行。跨模块重复条款/用例 ID 在入口拒绝。

### 判定、预算与盲审

- 每用例预检、准备、执行、自判、复核共享同一个 BudgetTracker 与 deadline；模型调用均计步数/token，所有操作和重试等待计入时长。初始化的全局配置校验不消耗每用例模型预算。
- finish 的结构校验和证据语义校验合并在同一个最多 3 次不合格额度中。每条预期恰有一个判定，不允许重复、漏项或额外项；引用必须属于当前 case/attempt，文件确已成功写入、哈希可验证。
- 沿用 unclear 可无证据的内核语义，但若提供 evidenceIds 仍检查存在性和归属。pass/fail 必须覆盖声明的全部证据类型。
- reviewer 由专用构造器从**条款原文、预期、工具生成的证据**构造新会话，绝不接 executor messages、finish 输出、reasoning、结论摘要或工具审计全集。截图可作为图片附件传入，文本来自脱敏快照/HAR/DB；页面文本按不可信数据处理。
- 按实际模型候选声明/配置图片能力，fallback 后同样适用。不支持图片时提供文本证据；若不能满足视觉判断，不允许假称看过截图或伪造 PASS/FAIL，返回 UNCLEAR/BLOCKED 并说明局限，不能静默放宽证据类型要求。
- 代码按 expectationId 配对有效判定再调用 decide/worstStatus。用例严重度保持现状；退出码用最终用例状态调用现有 exitCodeFor，保持已实现口径：不同用例含 FAIL 与 BLOCKED 时为 1；单用例汇总已是 BLOCKED 则为 2。工具自身错误优先为 3。
- 现场造数、模型重试/fallback、输出修正均保存低可靠原因；浏览器/HTTP/夹具写操作不自动重放重试。
- 画像漂移须指向明确的已确认操作约定与观察证据，不能把所有 404/元素缺失一概当漂移来掩盖业务 FAIL。

### 持久化与恢复

```text
.crosscheck/runs/<UTC时间戳-随机后缀>/
  manifest.json                 版本、输入指纹、环境、筛选、运行状态
  input.json                    脱敏的运行输入快照，不含环境变量值
  cases/<caseId>/attempts/<n>/
    trace.jsonl                 工具动作、定位器、脱敏输入/凭证引用、前后证据ID
    evidence/index.json         宿主生成的证据元数据
    evidence/<id>.<ext>          脱敏后的真实证据
    result.json                 单次尝试完整提交点
  results.json                  从已提交case结果汇总
  junit.xml
  report/index.html             离线静态报告
```

- 证据记录增加 runId/caseId/attempt/actionId、时间、mime、相对路径、哈希及脱敏状态；模型只能引用证据ID，不能指定文件路径或注册证据。
- 先落盘证据和轨迹，再原子写 case result 作为提交点；运行汇总可从提交点重建。按 run 排他锁避免并发 resume；不假装单文件 rename 等于多文件事务。
- `run --resume [runId]`：未指定 ID 选最新兼容的未完成运行；跳过已提交的正常完成用例（含 FAIL/DISPUTED/UNCLEAR/业务 BLOCKED），中断或崩溃的不完整尝试重新从预检开始并保留旧 attempt。业务 BLOCKED 修复后新开 run。
- Ctrl+C 停止派发下一用例；当前记 BLOCKED（中断）且 checkpoint 标识可重跑；取消模型、终止查询/子进程、关闭 context 后 flush 落盘，退出 2。恢复不重用 agent 对话或浏览器会话。
- 所有写路径由宿主生成，验证词法边界与现存父目录的物理路径，拒绝 symlink/junction 越界；原始密钥不写临时文件。

## 实施任务（按依赖顺序）

各任务遵循先失败测试、最小实现、通过测试、独立审查；未获用户要求不自动提交或推送。保留用户当前 `.gitignore` 的 `.idea` 修改，不恢复、不混入无关变更。

### Task 1: 冻结画像与运行数据契约，补门禁

关键路径：新增 `packages/core/src/schema/profile.ts`、`schema/run.ts`、`schema/evidence.ts`、`profile/load-profile.ts`；修改 `schema/config.ts`、`workflow/gate.ts`、`approvals/approvals.ts`、`index.ts`。

- 画像使用 versioned Zod discriminated union；运行结构共用 core schema，report 不另定义一套状态。
- 复用 ClauseSchema/TestCaseSchema/JudgementSchema、contentHash、Approvals，新增依赖绑定的 case 确认 API。
- 宿主自行枚举必需画像，门禁 fail-closed；未确认用例写 BLOCKED，不能筛掉后报告全绿；全局画像未确认则在任何副作用前拒绝。
- 测试缺文件、空清单、旧确认、条款修改再确认、重复跨模块 ID、非法 auth/fixture/环境引用。
- 审查后固定：SQL fixture 必须声明独立的准备连接环境变量引用，不与只读 data-model 连接复用；TraceEvent 保存结构化动作/定位器/脱敏输入与前后证据，不只存自由文本；Usage 可明确表示未知费用；CaseResult 自带 runId/attempt 与开始结束时间，支持独立恢复归属校验。

### Task 2: 受控工件存储与 case checkpoint

关键路径：修改 `packages/core/src/store/artifact-store.ts`；新增 `packages/runner/src/store/run-store.ts`、`checkpoint.ts`。

- 复用现有 UUID+rename 原子写，增加二进制受控写入、失败临时文件清理、错误统一 ArtifactError、路径物理边界校验。
- 实现 manifest/input/attempt/提交点/锁/汇总重建，不允许报告读取任意路径。
- 测试损坏 JSON/YAML、失败写入、并发 run、跨目录链接、崩溃发生于证据后/result前/result后等恢复边界。

### Task 3: 脱敏与可信证据仓库

关键路径：修改 `packages/core/src/redact/redact.ts`；新增 `packages/tools/src/evidence/{store,sanitize-har,sanitize-dom}.ts`。

- 复用 createRedactor，补 multipart、相对URL、SPA hash、session/sid/sessionId；HAR 按 header 数组、URL、cookies、postData、response.content 逐字段处理，不能只 value(har)。
- 对已读取凭证建立内存敏感值集合，清理文本/console/错误/轨迹中的精确匹配；DOM/截图遮蔽密码、敏感字段、包含已知敏感值的可见节点和批准的 selector；敏感输入轨迹保存环境变量引用。iframe/canvas等无法验证遮蔽的区域不得声称已脱敏，保守遮蔽或省略；必需截图因此不可用则阻断而非伪造证据。未知二进制/无法可靠清理的正文只保留元数据和省略说明。
- 禁止使用 Playwright 自动把原始 HAR/trace/storageState 写磁盘；以内存事件组装脱敏 HAR。证据采集失败不登记成功索引；用量字段不经过宽泛 token 键脱敏。
- 测试完整证据包及临时文件无凭证哨兵、统计仍为数字、敏感 DOM 不泄漏、伪造/跨case/缺文件证据无法用于判定。

### Task 4: 统一请求策略与 HTTP 工具

关键路径：修改 `packages/core/src/guard/{url-guard,sql-guard}.ts` 中实际需要的接口；新增 `packages/tools/src/network/{policy,http-client}.ts`、`http/tools.ts`。

- 复用 checkRequest；GuardrailsSchema 加载时验证主机格式；每跳请求都验证 URL/方法，限跳数，跨源剥除认证信息，响应体有大小上限。
- 拒绝方法覆盖头/查询/表单字段等歧义输入；HEAD 同时检查对应 GET 禁令。Content-Type 不支持时不冒险解析方法覆盖。
- HTTP 注入可取消 transport，真实实现取消请求；所有请求响应先采证后返回ID与脱敏摘要，不自动重试写操作。
- 本地两服务验证白名单外终点访问次数为0，覆盖301/302/303/307/308、循环、相对Location、凭证跨域和取消。

### Task 5: Chromium 工具与自动采证（先验收防护再接 agent）

关键路径：新增 `packages/tools/src/browser/{session,request-guard,actions,capture,tools}.ts`。

- Playwright 库直接调用，仅提供结构化 navigate/click/fill/select/press/wait/observe 等受限动作；不开放任意 evaluate、文件读取或shell。
- 每动作前后采集遮蔽截图和可访问性快照、网络与console，记录结构化定位器/输入引用/动作结果。
- **重定向防护是首个验证门槛**：常规 route 仅拦首跳，不能使用 route.continue 或 fulfill 3xx 冒充逐跳防护；不得通过“手动跟随后把最终响应塞回初始URL”破坏origin/cookie/导航语义。
- 首期对 Chromium 使用CDP `Fetch.requestPaused` Request阶段发送前拦截；从浏览器级target自动附着/暂停开始，为target安装防护后才恢复，不能等page/popup事件后补装。验证每跳以及iframe/OOPIF等所有受支持target；禁Service Worker，未覆盖安全策略的弹窗/worker/WebSocket/download须在首个请求发出前阻断。若做不到，不得开放该能力。CDP路线尚需实测，不预先声称保证。
- 此任务验收失败时停止浏览器接入并记录阻碍，不能静默改成仅HTTP或绕过守卫；缩减原定范围需重新说明。普通页面安全约束不等于对任意恶意网页的OS级网络沙箱。
- 真实浏览器测试断言目标服务的访问计数，而非只断言guard函数被调用；验证正常重定向最终URL/cookie、页面fetch/子资源、跨域阻断及中断后context关闭。

### Task 6: PostgreSQL 只读查询工具

关键路径：修改 `packages/core/src/guard/sql-guard.ts`；新增 `packages/tools/src/db/{postgres,tools}.ts`。

- 默认 SQL 守卫保持保守行为；增加显式 PG 参数模式，词法识别合法 `$n`，拒绝美元引用与其余歧义语法，校验占位符和有序参数声明；禁止正则替换参数或拼值进SQL。
- 连接串只从环境变量取；专属只读账号，固定只读事务、服务端 statement_timeout/lock_timeout，`queryMode: 'extended'` 禁止多语句；限制结果行数/大小并保存截断标记。
- 中断关闭专属连接，服务端超时兜底；query_timeout 不是取消保证。只读资格需要部署配置与实际验证，不能仅相信布尔字段。
- 独立凭证隔离 fixture SQL 写入，不让 db 工具获取写凭证。
- 单测用假client验证协议顺序；独立本地PG集成测试验证不能写、不能多语句、参数注入不生效、锁/语句超时与真实取消。缺少PG时显式报告未验证，不能假称通过。

### Task 7: 认证、夹具与按需画像工具

关键路径：新增 `packages/tools/src/{auth,fixtures,profile}/`，各自分schema适配/执行/tool文件。

- profile 仅检索已确认画像；没有读业务源码或搜索任意文件的工具，运行时发现只存建议不自动改批准画像。
- 预登记command使用shell:false、固定argv/环境变量引用、受控cwd；取消需结束子进程树，Windows单独验证。配置授权不向模型开放任意命令。已人工确认的命令是可信适配器，必须遵守不写项目源码/测试的约定；本阶段没有OS级沙箱，不能宣称能隔离恶意命令的网络和文件访问。
- 夹具HTTP走同一network policy，SQL用独立准备连接；reset→其余夹具→认证顺序固定，明确产出的业务ID用于执行。
- 现场造数只在prepare开放，输出所需状态、完成凭证与建议；没有状态证据不能直接宣称准备成功。
- 测试reset一次、顺序、fixture返回值、缺失fallback、execute无法调用fixture、认证凭证不进入轨迹、命令中断。

### Task 8: agent/models 接入修补与上下文压缩

关键路径：修改 `packages/agent/src/loop.ts`、`packages/models/src/{resolve,resilience}.ts`；新增 `packages/agent/src/context.ts`，必要时把loop的消息整理拆小文件。

- 修复工具名格式/重复名、同轮多个finish只记一次invalid、非法JSON反馈、中断时补齐tool-result；工具返回后立即复查signal和预算。
- 新增本地最终结果验证钩子，与结构校验共享3次额度；SDK只拿基础JSON Schema，不把运行时superRefine强行转JSON Schema。
- 增加宿主控制的证据消息装配入口：工具返回证据ID后，由EvidenceStore读取允许的脱敏图片/文本并构造SDK支持的附件，使executor和reviewer实际能查看证据，而不只是看到路径。按当前候选模型能力生成请求，fallback不直接复用不兼容附件；附件大小上限与压缩策略统一。
- 工具自行await证据/轨迹写入；agent同步回调只记录内存用量/审计，若改异步接口必须await，不用fire-and-forget。
- 上下文按确定阈值压缩旧截图/大型工具正文为对应证据ID与脱敏文本摘要，保留最近动作、全部判定依据和完整tool-call/result配对；磁盘证据不丢失，不额外调用模型生成可能含结论的盲审摘要。
- fallback缺密钥跳过并警告，主模型错误仍明确失败；补factory真实分支、同源endpoint/fallback警告、sleep监听器清理和已中止调用前检查。

### Task 9: 单用例执行管线、盲审与运行编排

关键路径：新增 `packages/runner/src/{run-case,run-suite,preflight,prepare,judgement,review-input,resume}.ts`。

- 使用runAgent、BudgetTracker、UsageMeter、checkJudgement、decide、worstStatus、exitCodeFor连接全部阶段；一个共享用例预算，finally统一清理。
- 输出语义校验仅查EvidenceStore已提交索引；review输入构造器与executor输出类型解耦，证据按需附件并限制大小，不能静默截断导致假判。
- 串行执行、立即提交、记录实际模型/fallback/用量/低可靠原因/漂移/建议；未知定价显示未知而不是假装零费用。
- resume依据快照指纹与case提交点；中断只影响当前用例，完成用例不重放夹具。
- 用scriptedModel确定性覆盖PASS/FAIL/DISPUTED/UNCLEAR/BLOCKED、预算、取消、损坏输出、重试及盲审哨兵隔离。

### Task 10: 离线报告与 CLI 交付

关键路径：新增 `packages/report/src/{results,junit,html}.ts`、`packages/cli/src/{index,run,report}.ts`、各包package配置和构建脚本；更新 README 与手工接入指南。

- 同一RunResult生成results.json/JUnit/XML/HTML；静态HTML无CDN依赖，不用file://下fetch读JSON。包括总览/矩阵/截图时间线/请求响应/双方判定/夹具建议/漂移。
- 所有文本HTML/XML转义，证据链接限运行目录内；不直接渲染采集到的HTML/SVG。FAIL→JUnit failure，DISPUTED/UNCLEAR/BLOCKED→skipped并明确原状态。
- `run --module <id> --case <id> --resume [runId]`，可选显式project/environment；筛选取交集，无匹配不全绿。`report <runId>`离线重建，打开浏览器为显式选项，不发模型请求。
- bin/构建产物可本地运行，测试不能依赖开发环境的隐式TS加载；验证依赖运行时最低Node版本。文档给完整手填画像、审核确认、配置env、构建、run/report命令，明确尚无init/TUI。
- SIGINT handler通过AbortController驱动管线；不在工具未终止/结果未flush前强行process.exit。

## 验证与交付标准

1. 每任务定向Vitest + 类型检查；最后 `pnpm test`、`pnpm typecheck`、新增 `pnpm build` 全量通过。计划阶段不运行会写缓存/文件的测试。
2. 本地临时HTTP应用 + 真实Chromium + scriptedModel 完整跑CLI：采证→双判→合议→三种报告；不调用外部模型、不消耗token。原约束“测试不访问网络”落实为不访问外部网络；必要集成仅loopback并显式分类。
3. 修改确认后的条款/画像必须在副作用前阻断；条款重新确认不能恢复旧case确认；未确认用例在结果中可见。
4. 白名单外终点收到0个请求；浏览器redirect防护先独立通过；执行阶段不能造夹具、数据库不能写。完整HAR/轨迹/报告/临时产物不含敏感哨兵。
5. reviewer实际收到的全部system/messages/图片或文本附件不得含executor结论/推理哨兵；反向判定必须DISPUTED。
6. 共享预算、Ctrl+C、崩溃与resume测试确认资源停止，完成case不会重复动作；输入变化拒绝续跑。
7. 断网或删改当前项目工件后，`report <runId>`仍能从保存快照重建；JSON/HTML/JUnit状态一致，恶意页面文本不会执行。
8. PostgreSQL真实测试、Windows子进程取消、最低Node版本与真实厂商联调分别记录“通过/失败/未执行”，不能用假模型或假client冒充。

## 完成后的可用性表述

完成本计划后，可以对**已启动、已手工配置并经人确认**的Web项目执行run/report闭环；尚不具备自动init/需求提取/用例生成/TUI审核，也不代表已达到靶场质量指标。真实模型运行只在用户提供测试环境与凭证并授权后进行。
