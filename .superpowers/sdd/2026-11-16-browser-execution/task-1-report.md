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
