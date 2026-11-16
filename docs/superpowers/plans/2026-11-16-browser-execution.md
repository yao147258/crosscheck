# 标准浏览器自动验收实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** AI 自动操作真实浏览器，采集证据、完成双判并生成验收报告。

**Architecture:** 用户已明确取消浏览器网络隔离要求。使用标准 Playwright Chromium，每用例独立上下文；页面请求正常运行，凭证脱敏、共享预算、人工确认和盲审保留。强制代理/CDP/WT/RTC 禁用不再是交付目标，不保留两套启动模式。

**Tech Stack:** TypeScript、pnpm、Zod、Playwright 1.65.0、Vitest、现有 AI SDK。

**Spec:** `docs/superpowers/specs/2026-11-16-browser-execution-design.md` 开头“当前有效裁定”优先于文档下方历史研究。

## Global Constraints

- 所有对话、文档和新增注释使用中文；不消耗真实模型 token。
- 浏览器不安装 RequestPolicy/CDP/本地代理拦截，不禁 WebRTC/WebTransport；用于用户信任的测试环境，不承诺网络隔离。HTTP/数据库工具守卫不变。
- 模型只获结构化浏览器动作，不获 evaluate、shell、任意文件读取和宿主路径。
- 环境变量凭证只在内存使用；证据先脱敏再落盘，不写原始 HAR/trace/storageState/未遮罩截图。被测项目内仅写 `.crosscheck/`。
- 人工确认、每用例预算、取消、工具阶段授权、reviewer 盲审、证据归属/哈希/完整呈现校验保留。
- 用户允许本分支本地提交，禁止自行合并/推送。用户 `.gitignore` 的 `.idea` 修改不纳入提交。
- 文件复制不用裸 cp（本机是启动其他CLI的alias）；不打印环境值或别名。

## 文件结构及验收

- tools/browser/session：标准 Playwright 启动、独立context与取消关闭。
- tools/browser/capture、events：安全 DOM/内存 PNG/有界网络console采证。
- tools/browser/actions、tools：结构化动作与AgentTool。
- agent/context、tools/evidence/presenter：按实际模型能力呈现图片和文本。
- tools/auth、runner：共享actor、惰性启动、审计和生命周期。
- cli测试和文档：真实浏览器+loopback应用+假模型闭环。

默认全量测试跳过真实浏览器时不得宣称真实验收通过；单列真实浏览器命令及结果。PG、最低Node、厂商模型联调若未跑明确未执行。

### Task 1: 标准 Playwright、动作和可信采证

**Files:** 修改 `packages/tools/src/browser/session.ts`、`packages/tools/src/evidence/{store,sanitize-dom}.ts`、`packages/core/src/schema/guardrails.ts`；创建 `packages/tools/src/browser/{capture,events,actions,tools}.ts` 和相应测试；修改 tools index。

**清理范围:** 删除本分支新增的 `browser/{network-proxy,request-guard}.ts` 及 `browser-{proxy,guard.mock,admission.real,session}.test.ts` 中只验证已取消网络隔离实现的文件/用例（先核对实际文件和git status，保留无关测试）。移除仅为代理增加且不再被消费的 hostPortAllowed 及其测试，恢复 HTTP 守卫原有语义。Git历史保留研究，不留死代码。

**Interfaces:**
```ts
interface BrowserSession { browser: Browser; context: BrowserContext; page: Page; close(): Promise<void> }
launchBrowserSession(options: { signal: AbortSignal; headless?: boolean }): Promise<BrowserSession>
// BrowserHost拥有session，以便惰性启动及取消清理；构造使用宿主options。
type BrowserAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'click' | 'observe'; locator?: TraceLocator }
  | { kind: 'fill'; locator: TraceLocator; value?: string; env?: string }
  | { kind: 'select'; locator: TraceLocator; values: string[] }
  | { kind: 'press'; locator: TraceLocator; key: string }
  | { kind: 'wait'; locator: TraceLocator; state: 'visible' | 'hidden' | 'attached' | 'detached' };
BrowserHost.perform(action, meta, signal): Promise<{ evidenceIds: string[]; summary: unknown }>
BrowserHost.close(): Promise<void>
createBrowserTools(host, nextMeta): AgentTool[] // 单工具 browser_action，category browser
```
TraceLocator沿用core中的css/role/text/testId/xpath。click必须有locator；observe可只观察整页。navigate仅HTTP(S)或相对baseURL，跟随正常网页行为不作目标白名单隔离。工具输入严格校验，fill value/env二选一，env值由宿主获取并addSecrets，输出/trace不暴露原值。提供宿主方法取得session/context供后续认证，不把它暴露给模型。

- [ ] **Step 1 RED:** 写失败测试：结构化动作及未知evaluate拒绝、正常页面fetch不因目标不在guardrails而被浏览器拦截、取消关闭context、敏感fill不入证据。
- [ ] **Step 2 实现标准会话与移除研究防护:** 用`chromium.launch`/`browser.newContext`，不自spawn/CDP/代理，不造进程树管理器。取消时await close，幂等关闭，启动失败清理部分资源。禁止自动文件下载，网络自身行为正常。
- [ ] **Step 3 实现采证:** screenshotMasks用optional不default，旧审批hash不变，修改selector必须失效。采集前后DOM和PNG，遮密码/敏感字段/已知secret/批准selector；iframe/canvas/svg/object/embed及无法清理的可视区域保守遮罩。PNG内存返回，仅可信采集器来源可saveScreenshot（模块私有WeakMap能力，不信complete:true）。不能依靠PNG字符串不含secret证明遮罩，需真实遮罩像素断言。DOM给出可用文本和定位信息，不序列化原始HTML。
- [ ] **Step 4 网络/console:** 内存监听真实request/response/failure和console，限定正文及事件总量，未知二进制只元数据，调用EvidenceStore.saveHar/saveText前清理；所有pending在flush/close await。可省略/截断但必须标注，采证存储失败不可伪装成功。每次动作前后采证，失败路径也保存已发生观察；不自动重放业务写。
- [ ] **Step 5 GREEN:** 真实临时loopback表单测试navigate/fill/click/select/press/wait/observe、env引用、missing locator、页面自身网络正常、取消、截图遮罩/DOM/console/HAR哨兵。扩展store.readTextEvidence支持dom、readScreenshotEvidence按ID/哈希读取PNG。定向测试+typecheck，通过后提交并独立审查。

### Task 2: 模型实际查看浏览器证据

**Files:** `packages/agent/src/{context,loop}.ts`、`packages/tools/src/evidence/presenter.ts`、`packages/runner/src/{judgement,review-input,run-case}.ts` 及对应测试。

**Interfaces:**
```ts
type PresentedEvidence = TextEvidence | ImageEvidence;
// TextEvidence.type加入dom；ImageEvidence为id,type:'screenshot',bytes,mediaType:'image/png',truncated。
// EvidencePresenter签名仍(ids,{ref,signal})，返回PresentedEvidence[]。
```
- [ ] **Step 1 RED:** 图片模型真实请求含image part、无图fallback不带图片且标记缺失；引用未呈现截图不能pass/fail；DOM文本实际进入模型；reviewer输入不含executor哨兵。
- [ ] **Step 2 实现:** presenter消费config.capabilities[ref].images，逐实际候选重新核验物化；PNG内存附件用SDK真实类型。图片累计字节/文本字符有限额，旧附件压缩保留ID，不能让首选shown状态泄露给fallback。沿用TextEvidence为文本分支，新增统一呈现结果通知以供runner校验，不重复模拟另一套限额算法。review-input仅接条款/预期/证据ID，不复制执行结论。
- [ ] **Step 3 GREEN:** 保留HTTP/DB原行为与不完整证据验证；定向agent/presenter/runner测试、typecheck、提交、独立审查。

### Task 3: 共享认证与 runner 接入

**Files:** `tools/src/auth/{host,browser}.ts`、`tools/src/fixtures/host.ts`、`runner/src/{run-case,run-suite,preflight}.ts`、CLI args/package、lockfile、对应测试。

**Interfaces:** BrowserHost宿主认证接口消费批准AuthAction（goto/click/fill(env)/waitFor）；认证后的HttpClientFacade从当前同源浏览器cookie构建请求身份，header/command/token凭证仅同源注入。storage token仅批准origin注入；不向模型返回cookie/密钥。原HTTP-only流程不要求安装或启动Chromium。

- [ ] **Step 1 RED:** form/replay登录后浏览器和HTTP都看到同actor；跨源不注入actor头；storage token在正确origin生效；reset→fixtures→auth顺序；HTTP-only不启动browser。
- [ ] **Step 2 实现认证:** 保留command动态身份解析前载荷省略和凭证addSecrets；移除preflight/auth/fixture“浏览器暂缓”硬编码。没有adapter时明确拒绝需要browser的认证而非匿名退化。只消费批准动作，不实现录制。
- [ ] **Step 3 runner:** 惰性BrowserHost入prepare缺失普通夹具fallback和execute工具，review无业务工具。同一budget/signal/deadline，所有浏览器动作计入既有工具轮次；audit记录结构化locator和secretRef，错误消息脱敏。取消、正常、异常都await浏览器/采集清理，再提交result；不复用resume浏览器。浏览器操作失败与宿主存储故障区分。
- [ ] **Step 4 GREEN:** runner脚本模型覆盖PASS/DISPUTED/UNCLEAR、无图候选、取消、预算、恢复与认证，typecheck。CLI运行时依赖正确，不只devDependency。提交并审查。

### Task 4: 真实 CLI 端到端及交付

**Files:** `packages/cli/test/{browser-e2e,harness}.ts`、README、已有手工接入指南、计划2 execution/contracts。
- [ ] **Step 1 RED:** 真实loopback应用+Chromium+scriptedModel执行表单流程，expectation要求screenshot/dom，执行器和reviewer确实拿到附件，三种报告状态一致，证据哈希/归属正确。
- [ ] **Step 2 文档:** 写明仅可信测试环境、无浏览器网络隔离；网页请求正常运行；填写screenshotMasks、图片能力、安装Chromium、构建run/report命令。保留旧裁定历史并以最新用户决策为准。不要再宣称浏览器allowedHosts涵盖所有网页自身请求。
- [ ] **Step 3 验收:** `pnpm typecheck`、`pnpm build`、`pnpm test`、`CROSSCHECK_REAL_BROWSER=1 pnpm vitest run` 对所有新增浏览器real与CLI用例。真实浏览器验证不只类型检查；无真实模型token。检查报告HTML无脚本注入、脱敏证据及临时目录无secret、关闭无残留、HTTP/DB回归。
- [ ] **Step 4:** 全分支独立审查、集中修复一次重要问题并复核；本地提交，保留worktree，不合并推送。
