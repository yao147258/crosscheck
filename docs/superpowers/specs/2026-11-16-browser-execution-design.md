# 浏览器执行能力设计：WebSocket 准入代理与 Task 5 恢复

> 本文件是设计说明（spec），不是实施计划。实施任务拆分见后续由 writing-plans 产出的计划文档。

## 1. 背景与裁定历史

计划 2 Task 5（`docs/superpowers/plans/2026-11-13-plan2-execution.md` 第125–134行）要求浏览器工具在发送前对所有受支持 target 的请求做准入拦截，未覆盖的能力不得开放。

2026-11-13 的真实 Chromium 准入验证（见 `.superpowers/sdd/2026-11-13-plan2-execution/task-5-report.md`）确认：

- 导航、逐跳重定向、子资源、fetch、iframe/OOPIF、弹窗首请求、dedicated worker、表单提交、下载，均已用 CDP `Fetch.requestPaused`（Request 阶段）在发送前拦截，25 项真实计数测试中 23 项通过。
- WebSocket 握手无法用已测 CDP 能力（`Fetch` 域不拦截 WebSocket；`Network.setBlockedURLs` 的 url/urlPattern 两种写法均被真实验证无效）在发送前阻断。按"未覆盖能力不得开放"原则，用户裁定暂缓浏览器工具，计划 2 本阶段只交付 HTTP/PostgreSQL（见 `2026-11-13-plan2-contracts.md` §4）。
- 该报告同时指出 WebTransport、WebRTC 很可能同样绕过 Fetch 域，需要和 WebSocket 一并裁定，但未测试。
- `packages/tools/src/browser/` 下的代码被契约文档明确标记为"未审查的研究成果，不导出、不接入"。

2026-11-16，用户要求恢复并完成浏览器执行能力，确认：

1. 采用 `task-5-report.md` 中的"方案A"：宿主强制本地代理，只按 host:port 放行，解决 WebSocket 阻碍。
2. WebTransport、WebRTC 彻底禁用并做轻量真机验证，不做完整准入矩阵。
3. 现有未提交的研究代码（`session.ts`、`request-guard.ts` 及两个测试文件）作为新 worktree 的起点，审查后继续开发，不推倒重写。

本文件记录该决策对应的技术设计。

## 2. 目标与范围

**本设计解决的问题**：在不违反"未覆盖能力不得开放"原则的前提下，让浏览器工具可以合法开放——即补上 WebSocket 的发送前准入控制，并为 WebTransport/WebRTC 提供同等强度（禁用而非选择性放行）的处理。

**不解决的问题**：

- 不追求 WebSocket/WebTransport/WebRTC 的路径、方法级策略执行——代理层只能做 host:port 级别的放行判断，这是方案 A 本身的局限，不是实现缺陷。
- 不在本设计中展开 Task 5 剩余的动作集/采证/AgentTool 工厂实现细节，这些已在计划文本中写明，直接进入实施计划，不需要重新设计。

## 3. 架构：本地强制代理

### 3.1 组件

新增 `packages/tools/src/browser/network-proxy.ts`，导出一个 `LocalForwardProxy`：

- 基于 Node `http.Server`，监听 `127.0.0.1:0`（宿主选随机端口，不对外暴露）。
- 处理两类请求：
  - **`CONNECT host:port`**：解析目标 host:port，交给协议无关的主机校验（见 3.2）。拒绝时不建立到目标的 TCP 连接、直接回错误并关闭客户端连接；允许时 `net.connect(port, host)`，建立后回 `200 Connection Established`，随后双向裸管道转发字节（不解析隧道内的 TLS/WS 内容）。
  - **裸 HTTP 绝对形式请求**（`GET http://host/path HTTP/1.1`）：同样先校验 host:port，再转发请求并回传响应（流式，不假设响应体大小）。
- `start()`/`stop()`：`stop()` 必须结束所有存活连接（不留悬挂隧道），且是幂等的。

### 3.2 主机校验：复用而非重复实现

`packages/core/src/guard/url-guard.ts` 现有的 `hostAllowed` 是私有函数，只接受 `URL` 对象（因此隐含 http/https 的默认端口语义）。代理层拿到的是裸 `host:port`（CONNECT 目标）或协议未知的请求，需要一个协议无关版本。

设计：在 `url-guard.ts` 新增并导出 `hostPortAllowed(hostname: string, port: string | null, entries: string[]): boolean`，内部复用现有的 `parseHostEntry`/通配符匹配逻辑；`hostAllowed` 改为基于它实现（不是并行维护两套匹配代码）。代理模块调用 `hostPortAllowed`，CONNECT 目标里显式给出的端口直接作为 `port` 参数，不做默认端口猜测（CONNECT 语义上端口总是显式的）。

这样白名单只有一份数据源（`GuardrailsSchema.allowedHosts`），HTTP 层的 `checkRequest` 和代理层的 host:port 校验永远不会出现两份解析逻辑分裂导致的不一致。

### 3.3 Chromium 启动参数（`session.ts`）

`BASE_ARGS` 调整：

- 追加 `--proxy-server=http://127.0.0.1:<代理端口>`。
- 追加 `--proxy-bypass-list=<-loopback>`：Chromium 默认对 loopback 地址有隐式绕过代理的行为，测试用的禁止/允许服务都绑定在 127.0.0.1/localhost，若不显式覆盖，代理形同虚设（这正是方案 A 在报告里标注"需要新的真实计数验证，不预设可行"的关键细节）。
- 现有 `--disable-features=...` 字符串**追加** `,WebTransport`（不能作为第二个独立的 `--disable-features` 开关传入——Chromium 对重复同名开关是整体覆盖而非合并）。
- 追加 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`，阻止 WebRTC 建立不走代理的 UDP 连接。

### 3.4 生命周期顺序

`launchGuardedChromium`：

1. 创建并 `start()` 代理，等待其真正进入监听状态（拿到实际端口）才继续——不能假设 `listen()` 调用后立即可用。
2. 用代理端口拼出 Chromium 参数，spawn 浏览器。
3. `close()`（既有函数）增加步骤：浏览器进程树确认退出后，`stop()` 代理并等待其完全关闭。顺序必须是"先关浏览器再关代理"还是反过来，需要和既有的"先杀进程再断 CDP pipe"顺序一起用真实测试验证（已知教训：关闭顺序错误会在 fail-closed 窗口期让请求漏出，见 `task-5-report.md` 关键发现 1）。

### 3.5 与现有 Fetch 域守卫的关系

代理不是替代 `GuardedCdpMux`，而是补充：

- HTTP(S) 请求仍以 `Fetch.requestPaused` 为主要防线（方法、路径、正文、方法覆盖等细粒度策略），代理层对这些请求的 host:port 校验是纵深防御，正常情况下不应该触发拒绝（如果触发，说明 Fetch 域有漏洞，这本身是有价值的信号，不应该静默吞掉，需要记录事件）。
- WebSocket（ws/wss）、以及任何会升级为持久隧道的 CONNECT 场景，代理层是**唯一**的发送前防线。

## 4. WebTransport / WebRTC 处理

按用户确认的范围，不做完整准入矩阵，只做"彻底关闭能力 + 轻量真机验证"：

- **WebTransport**：`--disable-features=...,WebTransport` 使该 API 在页面中不可用。验证：真实 Chromium 中 `typeof WebTransport === 'undefined'`（或构造函数调用立即抛出），作为一次性真机断言,不展开到重定向/iframe/worker 矩阵。
- **WebRTC**：`--force-webrtc-ip-handling-policy=disable_non_proxied_udp` 阻止非代理 UDP。验证：真机建立一次 `RTCPeerConnection` 并尝试连接到一个本地 UDP 监听器，断言该监听器的到达计数为 0。如实记录局限：这验证的是"默认策略下的直连候选被禁止"，不是"ICE/STUN 的所有候选类型都已穷尽测试"。

两者的真机测试放在 `browser-admission.real.test.ts` 中追加，复用现有的 `CROSSCHECK_REAL_BROWSER=1` 开关，不新增测试开关。

## 5. 测试与验证标准

1. **代理单元测试（mock 级，新文件）**：CONNECT 到允许/禁止的 host:port；裸 HTTP 绝对形式请求到允许/禁止目标；IPv6 字面量目标；条目未写端口时端口不受限；代理监听失败时上层 `launchGuardedChromium` 必须中止（不能静默退化为无代理启动）；代理 `stop()` 后已建立的隧道被终止。
2. **真实 Chromium 准入测试（扩展现有文件）**：
   - `browser-admission.real.test.ts` 中第20、21项（现有失败项）在代理生效后必须变为通过：F 服务器的 `upgrades` 计数仍为 0。
   - 新增一项：显式验证"若不设置 `--proxy-bypass-list=<-loopback>` 则 loopback 绕过代理"这一前提确实存在（反向验证，证明该参数不是可省略的装饰），或在代码注释中引用已知 Chromium 行为并以当前这组测试的通过/失败作为间接证据——具体取哪种留给实施阶段按实测结果决定，不在设计阶段预判。
   - 新增 WebTransport、WebRTC 的轻量真机断言（见第4节)。
3. 所有新测试遵循既有风格：断言服务端/监听器的真实计数，不是断言守卫函数被调用。
4. `pnpm typecheck`、`pnpm test`（含真实浏览器测试，默认 `CROSSCHECK_REAL_BROWSER` 未设置时沿用现状跳过策略，由实施计划决定是否调整默认行为）必须通过。

## 6. 风险与局限（如实记录，不得在实施中静默放宽）

- 方案 A 对 wss/ws 隧道只能做 host:port 级别放行，无法执行 forbidden 规则或方法级策略；报告与用例描述中必须明确写出这一点，不能描述成"WebSocket 已完全纳管"。
- 代理引入新的单点故障面：若代理进程异常但浏览器进程存活，所有网络请求应因连接失败而失败（fail-closed），但这需要真机验证确认 Chromium 在代理不可达时的行为确实是请求失败而不是绕行直连。
- `--force-webrtc-ip-handling-policy` 和 `--disable-features=WebTransport` 都是 Chromium 命令行开关而非正式对外承诺的稳定 API，版本升级后需要重新验证（与现有 `task-5-report.md` 对 `Network.setBlockedURLs` 失效的教训一致：命令行/CDP 行为需要用真实版本验证，不能凭文档假设）。
- 嵌套 worker、shared worker、`<link rel=prefetch>`、`navigator.sendBeacon`、`EventSource` 仍未测试（`task-5-report.md` 剩余事项），本设计不扩大这部分范围，留给 Task 5 剩余实施按原计划文本处理。

## 7. 文档裁定更新

实施时需要同步更新（不覆盖、不删除历史记录）：

- `docs/superpowers/plans/2026-11-13-plan2-execution.md` 开头"执行范围调整"段：追加 2026-11-16 裁定，说明浏览器工具恢复，Task 5 按原任务描述继续完成。
- `docs/superpowers/plans/2026-11-13-plan2-contracts.md` §4 "浏览器工具（暂缓，未交付）"：追加小节记录 WebSocket 阻碍已通过本设计的代理方案解决、WebTransport/WebRTC 裁定为禁用而非准入验证，并如实写明方案 A 的局限（第6节）。

## 8. 后续步骤

本设计覆盖的范围：代理模块、Chromium 启动参数调整、WebTransport/WebRTC 禁用与验证。

Task 5 剩余范围（动作集 navigate/click/fill/select/press/wait/observe、遮蔽截图与 `EvidenceStore.saveScreenshot` 接入、`guardrails.screenshotMasks` 字段与审批哈希测试、可访问性快照、HAR/console 采证、`ctx.signal` 取消、`createBrowserTools` AgentTool 工厂）沿用 `2026-11-13-plan2-execution.md` 第125–134行已有描述，不需要新设计，直接进入实施计划。

下一步：调用 writing-plans 技能，基于本设计 + 原计划文本，产出可执行的实施计划（任务拆分、依赖顺序、验证标准）。
