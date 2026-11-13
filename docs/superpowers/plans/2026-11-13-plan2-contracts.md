# 计划 2 消费契约与实施裁定

本文件记录计划 2 已审查的数据契约和兼容性决策，供后续工具、执行管线及计划 3 复用。**这是开发中的契约，不表示真实执行工具或 CLI 已全部实现。**

## 1. 系统画像

画像固定为 `.crosscheck/system/` 下七个文件。宿主通过 `loadProfile` 完整加载、校验、补默认值后，再确认解析结果。不能直接确认未解析 YAML 后假定哈希一定相同。

| 文件 | 主要字段 |
|---|---|
| environments.yaml | `version:1`、`environments` 名称映射；各项 `baseURL`、`healthcheck`、`reset`（具名夹具或 null）、可选 start/stop |
| auth.yaml | `version:1`、`actors` 映射；anonymous/form/token/replay/command |
| api-catalog.yaml | `version:1`、`operations` 映射；environment/method/path/description/knowledge/sources/可选 actor |
| pages.yaml | `version:1`、`pages` 映射；environment/path/description/knowledge/sources/可选 actor |
| data-model.yaml | `version:1`、可选 `connection:{kind:'postgres',env}`、`queries` 映射 |
| fixtures.yaml | `version:1`、`fixtures` 映射；command/http/sql 判别联合 |
| guardrails.yaml | 沿用现有 allowedHosts/forbidden/redactFields，不加 version |

没有某类功能也要提供并确认合法空配置，不能漏文件绕过画像门禁。真实运行必须选中已存在环境，且所选用例的 actor 存在。环境和目录的 URL 不构成网络授权，授权唯一来源仍是 guardrails。

### 认证与命令

- form/replay：已确认环境和受限动作数组；goto 只允许 HTTP(S) 或站内路径，fill 使用环境变量引用，不写密码值。
- token：环境变量名与 header/cookie/storage 注入位置，作用域由运行环境限定。
- command：固定 program、argv 和子进程环境变量名到宿主环境变量名的映射；没有任意 shell、eval 或模型模板。
- 命令是人工批准的可信适配器，`shell:false` 和 cwd 不构成 OS 沙箱。命令不得改被测项目源码或测试；测试环境业务状态修改由准备阶段明确授权。

### SQL 夹具和只读查询

- 普通 DB 工具只使用 data-model 的只读连接，并对具名查询及临时 SELECT 运行只读守卫。
- SQL fixture 必填独立 `connection:{kind:'postgres',env}`，以及 query 名、固定 params 数组；只在准备阶段执行。
- 画像拒绝 fixture 与只读连接使用同一个环境变量名。两个不同变量也可能实际指向同一账号，schema 不能证明权限隔离；部署与适配器必须再验证。
- SQL fixture 可引用已确认 queries 中的 SQL，但只读工具不会因为 query 已确认就绕过守卫。
- 用例继续使用 `fixtures:string[]`。普通夹具缺失可交准备阶段现场造数；必需 reset 不存在、既有夹具失败不能靠现场猜测替代。

## 2. 人工确认与运行输入

确认公开入口：

- `Approvals.approveCase(tc, clauses, by, at?)`
- `Approvals.stateCase(tc, clauses)`
- `caseApprovalPayload(tc, clauses)`
- `assertStoredProfileApproved(store, approvals)`
- `loadVerifiedRunInputs(store, {environment?,modules?,caseIds?})`

用例确认 payload 绑定用例自身及 covers 对应条款的内容哈希。条款修改后，即使重新确认条款，旧用例确认仍失效。旧版仅对用例自身内容的确认不自动升级，需人重新确认。

`VerifiedRunInputs` 包含 config、七文件 profile、条款、筛选用例、环境、模块、ready/blocked 分类、缺失普通夹具、审批状态及 fingerprint。未确认用例仍保留，不能筛除后报告全绿。跨模块重复 ID、非法引用、未知筛选拒绝。

fingerprint 绑定解析内容、选择范围与审批状态，不含密钥值，不因同内容重新确认的 by/at 变化而变化。运行和恢复不能混用不同指纹的输入。

## 3. 证据与轨迹

`EvidenceRecord` 必须具有 id/type/runId/caseId/attempt/actionId/phase/time/mime/path/digest/redacted，可附 summary。path 是相对 `.crosscheck/` 的安全路径，digest 是 SHA-256。

这些字段只是结构契约，不能证明真的采集、脱敏或写入成功。证据仓库必须成功落盘后才登记索引，并验证文件、哈希与 run/case/attempt 归属。模型只能引用 ID，不能注册证据或指定文件路径。

`TraceEvent` 结构化保存：

- run/case/attempt/action、phase/time/event/message；
- action：type、locator、input；
- locator：css/role/text/testId/xpath、value、可选 name；
- input：已脱敏 JSON 或 `{kind:'secretRef',env}`，无输入用 null；
- beforeEvidenceIds、afterEvidenceIds；
- result：pending/success/error/blocked、脱敏 output/error；
- durationMs。

不把全部轨迹藏在自由文本 message 里。`redacted:true` 只是宿主声明，真实清理仍由采集器负责。原始 HAR、storageState、未遮蔽截图不得先落盘再清洗。

## 4. 运行结果

`CaseResult` 包含 runId、caseId、attempt、start/end、budget、complete、status、expectations、usage、reliability、suggestions、drift、可选 reason。

- 完整结果不得没有预期，预期 ID 不重复，双方判定必须指向同一预期。
- 判定状态由现有 decide/worstStatus 计算；不完整结果必须 BLOCKED。
- runner 还必须对原 TestCase 验证预期完整覆盖，schema 单独拿不到原用例，不能代替该检查。
- `RunResult` 检查 case 的 runId 与 manifest 一致，selectedCaseIds 与结果严格一一对应，包括 BLOCKED。
- 独立 case result 是提交点；保存成功前不能因有部分证据就当作完成。恢复不复用模型对话或浏览器 session。

### 费用、预算

费用使用判别联合：

- `pricingKnown:true,cost:非负数`，允许真实免费为 0；
- `pricingKnown:false,cost:null`，不能未知费用伪装为零。

当前 models 的旧 UsageMeter 缺价仍按 0 计，后续 runner 必须显式转换或更新计量接口，不能直接把旧值当已知费用。

budget 保存 limits 和 used（steps/tokens/elapsedMs）及耗尽原因。steps/tokens 是安全整数，运行汇总严格相等；elapsedMs 可使用浮点容差。每用例共享预算，模型外层代理轮次与 retry/fallback 次数分别记录。

### 文件布局与写入规则

运行目录采用 `runs/<runId>/cases/<caseId>/attempts/<n>/`；轨迹为 `trace.jsonl`，证据索引为 `evidence/index.json`，载荷限定在 `evidence/files/<宿主ID>.<ext>`，最后写入 `result.json` 作为提交点。运行级汇总为 `results.json`。

Windows 上索引路径大小写别名不能成为证据载荷；ID 和扩展名均由宿主固定生成，拒绝 DOS 设备名。首期载荷仅支持 PNG、JSON、纯文本及 HAR，对应 png/json/txt/har 扩展名，不渲染外部 HTML/SVG。

RunStore 在提交及恢复消费结果时检查证据文件存在、摘要匹配、引用 ID 存在与索引 ID 唯一，不能只在打开报告时才检查。锁必须在完整写入后原子排他发布；已有活锁或无法判断的锁不能删除。恢复为有界保守策略，连续崩溃耗尽保护层时明确报错并要求人工核实，不宣称无限自动恢复。

### 证据仓库消费约定

- DB 数据经结构化 `saveJson('db', value, meta)`，或可解析 JSON 的 DB 文本入口清理敏感键；不能只按已知 secret 字符串替换。
- HAR 必须从内存清理标准字段，含 headers/cookies/query/postData/content/Location；无效 URL 和不可解析正文明确省略，不能原文回退。
- `postData.params` 保留安全表单参数并清理敏感字段，不支持格式明确标记省略。
- 同进程多实例按物理项目根与 attempt 串行登记索引；跨进程仍要求宿主在采集至提交整个生命周期持有 RunStore 锁。
- 截图登记尚未开放，必须等可信浏览器采集实际遮罩通过后接入。自由文本仅保证已知 secret 与指定编码变体替换，不能自动识别所有未知秘密。

### HTTP 工具消费约定

`RequestPolicy.check` 每跳发送前执行；HEAD 同时检查 GET 禁令，拒绝 URL userinfo、方法覆盖与无法验证的正文。HTTP 原生 transport 禁用自动重定向，由宿主逐跳校验；允许业务写请求，但不自动重试。

`HttpClient.request(input, meta, authHeaders?)` 的认证头只允许宿主注入。每次注入的所有头名都会自动加入跨 origin 剥离集合，目标站点在白名单中不代表能接收源站身份。模型工具仅接受有限业务头，拒绝敏感字段裸值。

`createHttpTools(client: HttpClientFacade, nextMeta)` 产生可授予的 `http_request` AgentTool，actionId/phase 来自宿主。Facade 必须有 request 和 recordBlocked；actor 包装同时转发二者。模型校验拒绝写安全的未发送事件、不保存敏感原输入、不调用 transport，并返回真实证据 ID；采证失败原样传播宿主错误。

网络、取消、超限等操作错误使用 `HttpOperationError` 携带已保存 evidenceIds。status 0 是宿主失败/未发送事件，不是实际服务器响应；真实 HTTP 响应另有独立记录。存储异常不能伪装网络故障或静默变成无证据成功。

### 浏览器工具（暂缓，未交付）

2026-11-13 用户裁定暂缓浏览器工具，计划 2 只交付 HTTP/DB 闭环。

- 真实 Chromium 1254 准入验证中，CDP `Fetch.requestPaused` 在已测路径上做到了发送前拦截：导航、逐跳重定向、子资源、fetch、iframe/OOPIF、弹窗首请求、dedicated worker、表单、下载。
- 但 WebSocket 握手无法用 Fetch 或 `Network.setBlockedURLs` 在发送前阻断；WebTransport/WebRTC 未测。按"未覆盖能力不得开放"，浏览器能力不开放。
- `packages/tools/src/browser/` 下的代码是未审查的研究成果，不导出、不接入，任何任务不得消费。
- 本阶段不产生 screenshot/dom 证据。要求这两类证据的用例，以及 form/replay 认证的用例，在副作用前 BLOCKED 并写明原因。token 的 storage 注入同样不支持。
- 后续恢复浏览器（含计划 3 record 复用安全采集）必须先解决 WebSocket（候选：宿主强制本地代理，只按 host:port 放行），再补完动作、遮蔽截图、采证和工具工厂，并独立审查。

## 5. 模型能力与兼容性

- 图片能力配置为顶层 `capabilities[完整模型ref].images`，缺失按 false。
- 每次实际候选调用、包括 fallback，按其 ref 重新构造兼容消息。JSON 工具结果中的图片路径不等于模型看到了图片。
- reviewer 新会话仅包含条款原文、预期、工具证据，不含 executor 结论、推理、原会话或含结论的摘要。
- 当前 AI SDK 7/provider 4 的运行要求为 Node ≥22；项目暂以 Node ≥22.12 为开发和交付基线，不能沿用旧文档承诺 Node20。最低运行版本仍须真实冒烟验证。

## 6. 未包含的能力

本契约不实现自动发现、人工录制、init/reqs/plan、Ink 审核、人工裁决持久化、脚本固化或质量评测。这些仍属于后续计划。人工结果审核应附加裁决记录，不覆盖原机器结论；具体格式由计划 3 确定。
