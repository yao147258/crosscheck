# Task 1 本地代理与 Chromium 安全准入报告

## 结论：BLOCKED

2026-11-16，在指定 worktree、分支 `worktree-worktree-plan2-browser`、BASE `8dc0a68` 上实现并测试了唯一 host:port 匹配器、本地代理与会话接入。但真实 Chromium 未满足 WebTransport / WebRTC 彻底禁用要求，**本任务未通过安全准入，不得导出或接入浏览器能力**。失败断言保留为普通失败，没有跳过或改为预期失败。未实施 Task 2–5、未启动 reviewer、未合并、未推送、未发布，也未调用模型。

已在首次确认开关无效、UDP 到达后立即向用户报告安全阻碍。随后仅做本轮实现的自审、回归与复核阻塞证据，不继续采证/runner 功能开发。

## 本轮更改

- `packages/core/src/guard/url-guard.ts`：新增 `hostPortAllowed`，复用既有条目解析与合法性校验；既有 `hostAllowed` 保留 HTTP/HTTPS 默认端口推导，再调用唯一匹配器。现有 core index 星号导出自动覆盖，无新增第二套白名单。
- `packages/tools/src/browser/network-proxy.ts`：新增 IPv4 loopback 随机端口 HTTP/CONNECT 代理；显式端口、IPv6 方括号、非法/歧义 authority、userinfo、Host 重复/冲突检查在建立上游连接前完成；HTTP 剥离代理凭证及逐跳头、保留 origin Host 和路径、不跟随重定向；支持 WS 升级转发；追踪两端连接，幂等 stop 结束活隧道。安全事件仅含主机、端口与允许/拒绝结果。
- `packages/tools/src/browser/session.ts`：新增必须传入的 `allowedHosts`；代理先监听再 spawn；固定代理与 loopback 禁绕过参数、禁 QUIC、计划指定 RTC 策略；WebTransport 合并到唯一 disable-features。未增加调用方可传任意启动参数的入口。spawn 失败及时清理；异常退出/代理错误触发终止与清理；正常 close 先杀进程树并等待进程 close，再断 mux、停代理，支持并发幂等 close，不填 fatalReason。
- `packages/tools/src/browser/request-guard.ts`：正常关闭与 fatal 区分；删除全部原始 CDP 调试输出；保持 Fetch 安装完成后才转发 attachedToTarget 的顺序，下载仍强制 deny，普通 HTTP(S) 的方法/路径/正文策略没有移到仅主机代理。
- 测试新增真实 HTTP/TCP 代理边界、正常关闭/日志泄露回归、spawn 失败，以及真实 WT/RTC 禁用断言与无防护对照。旧 WS 测试改为允许白名单 A 握手到达、F 握手与 TCP 为零，不再要求允许主机也被禁止。

## RED / GREEN 记录

以下命令均在 `E:/crosscheck/.claude/worktrees/worktree-plan2-browser` 执行，真实浏览器均只访问 loopback。

| 轮次 | 命令 | 结果与说明 |
| --- | --- | --- |
| 匹配器 RED | `pnpm vitest run packages/core/test/guards.test.ts` | 8 failed / 83 passed，新增接口不存在，`hostPortAllowed is not a function`。 |
| 匹配器 GREEN、代理 RED | `pnpm vitest run packages/core/test/guards.test.ts packages/tools/test/browser-proxy.test.ts` | core 91 passed；代理模块尚不存在而加载失败。这一轮是缺模块 RED，不伪称行为断言失败。 |
| 代理 GREEN | `pnpm vitest run packages/tools/test/browser-proxy.test.ts` | 13 passed。首次运行有测试夹具问题：HTTP 头不能使用中文值，换为 ASCII 测试值后通过，未借此更改生产判断。 |
| mux RED | `pnpm vitest run packages/tools/test/browser-guard.mock.test.ts` | 2 failed / 10 passed：正常关闭填 fatal；调试日志暴露测试 authorization 参数。 |
| mux GREEN | 同上 | 12 passed。 |
| 真实禁用 RED（接入前） | `$env:CROSSCHECK_REAL_BROWSER='1'; pnpm vitest run packages/tools/test/browser-admission.real.test.ts -t 'WebTransport|WebRTC|WebSocket 按'` | WT 仍可构造；RTC 对照 4 UDP / 1 TCP，受控也是 4/1。另一个 WS 筛选测试依赖之前初始化 page，报未初始化，该项不是有效 RED 证据。后续完整真实套件验证 WS。 |
| spawn RED | `$env:CROSSCHECK_REAL_BROWSER='1'; pnpm vitest run packages/tools/test/browser-admission.real.test.ts -t 'spawn 失败'` | 4000ms 超时，原实现等待不存在的 exit。 |
| 接入后真实测试 | `$env:CROSSCHECK_REAL_BROWSER='1'; pnpm vitest run packages/tools/test/browser-admission.real.test.ts -t 'spawn 失败|WebTransport|WebRTC'` | spawn GREEN；WT/RTC 仍 RED，接入后受控 UDP/TCP 为 4/0。 |
| 完整真实准入 | `$env:CROSSCHECK_REAL_BROWSER='1'; pnpm vitest run packages/tools/test/browser-admission.real.test.ts` | **26 passed / 4 failed**；仅 WT 两开关对照、受控 WT、RTC 禁用断言失败。耗时约 25 秒。 |
| 提交前定向 | `pnpm vitest run packages/core/test/guards.test.ts packages/tools/test/browser-proxy.test.ts packages/tools/test/browser-guard.mock.test.ts` | **116 passed**。 |
| 类型检查 | `pnpm typecheck` | **通过**。测试脚本改用浏览器上下文字符串执行，避免宿主 TS 未配置 DOM 库导致的类型错误；未修改生产 TS 配置。 |
| 一次默认全量回归 | `pnpm test` | **50 files passed / 2 skipped；845 passed / 37 skipped**。真实浏览器默认跳过，不能把这项当作真实准入通过。 |
| 最终阻塞复核 | `$env:CROSSCHECK_REAL_BROWSER='1'; pnpm vitest run packages/tools/test/browser-admission.real.test.ts -t 'WebTransport|WebRTC'` | **4 failed / 26 skipped**，明确断言 isSecureContext=true 后仍复现相同 WT/RTC 结果。 |
| 补丁检查 | `git diff --check` | 通过。 |

生产更改先有上述 RED 再实现；未满足的安全要求没有通过放宽断言变 GREEN。

## 真实版本、服务端计数与禁用结果

- Windows 10 Pro 10.0.19045；Node **v24.9.0**；Vitest **5.1.0**。
- Playwright 测试锁定 **1.65.0**，可执行文件路径 revision **1254**；完整真实套件的版本断言通过，Chromium 实测 **158.0.8127.18**。
- 代理 13 项真实 TCP 测试：禁止 HTTP 目标 TCP/HTTP/upgrade 均 **0**；禁止 CONNECT 目标 TCP **0**；允许目标实际响应 HTTP、建立 CONNECT；IPv6、无端口条目、畸形 CONNECT、凭证、重复/冲突 Host、上游错误、客户端提前断开与 stop 活隧道通过。
- 完整真实浏览器套件：F 的 HTTP/upgrade 为 **0**，WS 场景 F 的 TCP 为 **0**；A 的 `/ws-allowed-host` 升级请求确实到达。该服务收到握手后主动断开，因此证明的是“握手准入到达”，不是完整双向 WS 消息会话。
- 原有 301/302/303/307/308 逐跳准入、跨站导航、cookie、OOPIF、页面子资源、dedicated worker fetch/importScripts、Service Worker 拒绝、弹窗、POST 正文与下载策略断言通过。正常并发 close 后 fatalReason 未设置，进程退出，Win32 profile 关联 chrome.exe 残留数 **0**；spawn 错误测试也通过。
- **WebTransport 失败**：在安全 loopback 页面，单独 `--disable-features=WebTransport` 与 `--disable-blink-features=WebTransport` 都仍可构造对象；受控浏览器也仍可构造。不是以 ready 超时作为禁用证据。没有找到并实证有效的正确 Blink 禁用开关，不能声称 WT 已禁用；未做 WT UDP 到达或真实 HTTP/3 握手验证。
- **WebRTC 失败**：本地 UDP/STUN 与 TCP/TURN 监听器有真实计数。无防护 Chromium 创建两个 PeerConnection、data channel、offer/localDescription，等待 2500ms，收到 **UDP 4 / TCP 1**。接入代理并使用 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` 后，受控浏览器相同尝试收到 **UDP 4 / TCP 0**，连续复测一致。策略名称不是安全保证，已有直接 UDP 到达反证。TCP 0 仅说明这个非白名单 TURN/TCP 对照未到达，不能说明允许主机、所有候选或 RTC API 已彻底禁用。

## 自审、范围与尚未完成项

1. 没有使用页面 init script、routeWebSocket 或 OS 防火墙充当安全边界；没有给模型传启动参数，没有新增配置模板，没有导出 browser 模块。
2. WS/WSS 代理只做 host:port 准入，隧道内不能执行 forbidden、方法或正文策略；不能描述为“WebSocket 已完全纳管”。普通 HTTP(S) 的 Fetch 细粒度策略保持原实现。
3. 已检查正常销毁顺序与研究代码实际注释矛盾，改为进程树先终止，再断 pipe；正常关闭不再被标为 fatal。异常路径仍依赖 taskkill/进程组终止行为，未穷尽 kill 失败、启动时异常退出竞态、代理异常全部故障注入，不能声称所有故障清理矩阵已完成。
4. 由于安全阻碍提前停止，**未补齐 dedicated/nested worker WS 与允许 noopener 初始脚本 WS 对照、代理不可达时不直连真机故障注入、downloads 目录实际无文件检查**。既有下载测试虽名字含“不落盘”，只验证 deny/请求事件，没有文件系统断言，不能拿其通过证明磁盘无文件。
5. 代理本身已覆盖核心真实连接测试，但尚未补齐独立的完整成功升级后双向 WS 数据/关闭测试和代理监听故障注入。回调异常、慢连接/资源耗尽、所有 HTTP framing 组合也不在本轮已验证范围；此代理不是对任意恶意网页的 OS 网络沙箱。
6. 完整真实套件在记录阻碍后仍执行了已有测试，用于检查本轮改动未破坏已有行为；没有继续后续任务功能。
7. 未输出环境变量或 alias 清单，未生成 HAR/trace/storageState/截图，也未记录原始 CDP。临时 profile 与 loopback 测试资源由测试清理。保留用户 `.gitignore` 的 `.idea` 修改且不暂存。
8. 安全阻碍必须解决并重跑真实准入后才能继续；当前提交仅供独立审查与恢复开发，不能视为 Task 1 验收通过。

## fix round1：F1–F5 审查修复（BASE b5ca0cb，仍为 BLOCKED）

本节是追加记录，不覆盖上文历史结论。独立审查原文 `task-1-review.md` 未修改；其 F1–F5 原文继续作为修复要求，不能将其改称仅测试不足。本轮没有试验 WT/RTC 新开关、没有修改现存禁用失败断言或 T1 候选开关对照，也未开展新架构与后续任务。

### 逐项处理及剩余阻碍

- **F1 尚未完整解决，明确保留阻碍**：POSIX 不再因根进程 exitCode/signalCode 已设置就返回，仍对 detached 进程组发送 SIGKILL 并探测组消失；未回退为只杀根 PID。Windows 根进程已退出时明确拒绝并报告“Windows 后代进程所有权未建立，无法确认清理”，停止代理，保持 mux 不转发且不主动断 pipe。已退出 PID 可能被重用，因此不能盲目再 taskkill，也不能用 profile 枚举或根 close 伪造后代终止证明。**这不是 F1 要求的可靠后代清理完成，只是移除假成功并显式升级。**
- Windows 完整所有权方案需要启动时原生 Job Object 边界：宿主/原生 helper 以 suspended 创建受控 Chromium 根进程，设置禁止逃逸及 kill-on-job-close，加入 Job 后才恢复，保有 Job 句柄并等待活动进程清空；还须验证 Chromium 自身 sandbox/job 嵌套兼容、宿主/helper 异常退出、pipe 继承和超时。纯 Node spawn 后再绑定会留下绑定前派生竞态，taskkill 已退出根 PID 不能补齐。本轮未获该依赖/helper 架构决策，不引入原生依赖、Job Object helper、外部平台脚本。POSIX 进程组也不是恶意进程自行 setsid 逃逸的 OS 沙箱，本轮没有真实 POSIX 故障验收。
- **F2 有界与失败升级已修**：移除阻塞事件循环的 spawnSync；taskkill 改用 execFile，设置 5000ms 子进程 timeout，并增加宿主 5000ms 等待上限；检查 error（包含非零、无法启动、被终止等）。后续根进程/stdio close 等待另有 5000ms 上限。超时/失败导致 close 拒绝、fatalReason 固定安全错误，并通过 finally 停止代理；不能称为清理成功。Windows taskkill 成功仍不是 Job Object 级所有权证明，受 F1 阻碍限制。
- **F3 主动断管道顺序已修，终止保证仍受 F1 限制**：mux.shutdown 返回 Promise，onFatal 可返回 Promise。同步停止所有转发和命令发送，等待 session 的统一 terminate 确认，再主动 channel.close；普通 close 也走同一路径。回调失败时 mux 保留 pipe 并设置固定 cleanupFailure，不把错误或秘密抛到网络事件。session 的 onFatal 只等待 terminate，不反向调用 close，避免互等。若 reader 已物理断开，无法撤销；记录 CDP 断开原因并立即尝试有界终止，不能宣称“从未提前断连”。
- **F4 已修**：手工序列化 101 响应时数组头逐值输出独立头行。真实 loopback 测试确认含 Expires 的第一条 Set-Cookie 与第二条保持独立，并验证服务器→客户端未掩码文本帧、客户端→服务器掩码文本帧字节完整，stop 后客户端与上游服务端 socket 均关闭。该测试是有限短帧转发测试，不声称完整 WS 协议实现或浏览器 Cookie 仓库的全部语义已验收。
- **F5 已修本轮回调异常边界**：代理 onEvent 同步抛错立即拒绝当前目标、标记固定 fatalReason、进入停止态并清理；onFatal 同步抛错或异步拒绝不能阻止代理 stop。HTTP、CONNECT、WS 三路零上游 TCP 的测试通过。Fetch onEvent 抛错也不继续放行，交由统一 fatal。回调原始错误不写入安全故障信息。onEvent 仍是同步接口，未宣称异步审计持久化回调受支持。
- **审计接线已补**：LaunchOptions 增加宿主 `onProxyEvent`，实际 session 将其接入 LocalForwardProxy.onEvent；事件仅有 kind/hostname/port，不记录原始 URL、请求头或正文。真实浏览器 WS 禁止尝试的回调确实收到 blocked 主机端口事件。它是宿主审计入口，不是模型工具或任意启动参数入口。

### 测试文件、RED/GREEN 命令及结果

全部在指定 worktree 执行；mock 终止测试只证明控制流和失败升级，不是进程树真实清空证据。

| 命令 | RED / GREEN 证据 |
| --- | --- |
| `pnpm vitest run packages/tools/test/browser-guard.mock.test.ts` | 新增延迟 fatal、同步抛错、异步拒绝、Fetch 审计异常后首次 **4 failed / 12 passed**，另有未处理拒绝；显示原实现过早关闭 pipe、异常逃逸。修复后均通过，最终该文件 16 passed，无未处理错误。 |
| `pnpm vitest run packages/tools/test/browser-proxy.test.ts packages/tools/test/browser-guard.mock.test.ts` | 首次 **4 failed / 29 passed**，3 个未捕获异常；Cookie 从两条被合成一条，三类审计异常使请求悬挂。修复后代理文件 **17 passed**，包含真实成功 101、多 Cookie、双向完整短帧及两端关闭。 |
| `pnpm vitest run packages/tools/test/browser-session.mock.test.ts` | 首次 **5 failed**：根先退出错误成功、taskkill 失败/挂起/根未退出三项超时、审计未接线。新增测试与修复后最终 **8 passed**。覆盖 taskkill 非零/ENOENT/挂起、根退出等待超时、根先退出的 Windows 明确所有权阻碍、POSIX 组终止与探测、延迟 fatal、物理 pipe 断开、事件接线。Windows 根先退出原先设想再次 taskkill，核对 PID 重用后改为期待明确所有权阻碍；没有将其记为可靠后代清理 GREEN。 |
| `pnpm vitest run packages/core/test/guards.test.ts packages/tools/test/browser-proxy.test.ts packages/tools/test/browser-guard.mock.test.ts packages/tools/test/browser-session.mock.test.ts` | 提交前最终 **132 passed / 4 files passed**。 |
| `pnpm typecheck` | 最终通过。首次新增 Promise onFatal 后测试辅助函数隐式返回 push 的 number，修为 void 后通过，未降低类型要求。 |
| `$env:CROSSCHECK_REAL_BROWSER='1'; pnpm vitest run packages/tools/test/browser-admission.real.test.ts -t '实际 session\|spawn 失败\|关闭后浏览器'` | 首次 **2 passed / 1 failed**：正常终止物理 pipe 关闭被误记 fatal，属本轮异步终止引出的回归；修复为关闭过程中不新增 fatal 并统一 mux 停止转发路径后，**3 passed / 28 skipped**。测试覆盖实际安全事件接线、缺失 exe 与正常并发 close；未把筛选跳过的 WT/RTC 记为通过，原失败断言完全保留。本轮没有完整重跑 WT/RTC 或试新参数。 |
| `git diff --check` | 通过。 |

### 本轮验收边界

本轮修复了 F2–F5 的上述可定位控制流/语义问题，F1 的 Windows 可靠资源所有权仍需协调架构决策；F3 的等待只可能等待到已建立终止边界的结果，不能凭 Promise 接口消除 F1 平台缺口。现有 WT/RTC 阻碍及 Task 1 其他未覆盖项均保持开放。未派子代理、未启动 reviewer、未更改或提交用户 .gitignore、未合并推送；提交仅限修复源码、相关测试及本报告追加。
