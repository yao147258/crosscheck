# Task 1 标准浏览器执行与可信采证报告

## 范围与状态

- 基线：`5bf5b2823319227a47e7759c7cc7e5f40da4a501`；工作分支：`worktree-worktree-plan2-browser`。
- 已实现标准 Playwright 会话、结构化动作、可信截图入库、DOM 与内存网络/console 采证；未实现后续模型多模态、认证共享 actor、runner 接入。
- 使用指定工作区，不派子代理、不调用真实模型、不合并、不推送。用户 `.gitignore` 修改保留且不纳入提交。旧 `task-1-report.md` 不改动。
- 本报告依据当前 Task 1 简报和最新有效裁定，不延续历史网络隔离要求。

## RED → GREEN 记录

1. 首先新增 `browser-standard.test.ts` 与 `browser-standard.real.test.ts`，随后执行：
   - `pnpm vitest run packages/tools/test/browser-standard.test.ts`：3 项失败，分别缺失 BrowserHost、screenshotMasks 被丢弃、DOM 读取被拒绝。
   - PowerShell `$env:CROSSCHECK_REAL_BROWSER='1'; pnpm vitest run packages/tools/test/browser-standard.real.test.ts`：2 项失败，缺失 BrowserHost；没有把导入错误当作 RED。
2. 实现标准会话、动作、截图能力、DOM、网络/console 后，单元测试通过；真实表单 click 首轮失败，定位为测试服务未声明 UTF-8，中文 role 名称被浏览器错误解码，修正测试响应字符集后通过。
3. 补充边界 RED：
   - 普通 `Error('测试磁盘故障')` 被错误包装为业务失败；改为采集与存储分层，所有存储拒绝保留失败语义。
   - `saveHar` await 期间注入真实 console 事件，原先 flush 尾部清空导致事件丢失；改为写盘前交换缓冲区。
   - console 源省略记录原先 `sourceIncomplete=false`；改为明确标记不完整。
   - 已有会话遇到预取消 signal 原先仍存活；改为等待关闭后拒绝。
   - 敏感输入 DOM 原先丢失定位信息；改为保留清洗后的 selector/type/name，不返回值。
4. 默认回归初次结果：819 通过、1 失败、15 跳过；失败为 CLI 恢复测试 5000ms 超时。隔离重跑同样超时，查明 tools 新导出使 HTTP-only CLI 每次启动同步加载 Playwright。改成会话启动时动态导入 Playwright，未修改原 CLI 测试超时；隔离 CLI 14 项通过，最终完整回归全部通过。

## 最终真实执行命令与结果

执行位置均为 `E:/crosscheck/.claude/worktrees/worktree-plan2-browser`。

- `pnpm typecheck`：成功，无 TypeScript 错误。
- `pnpm test`：50 个文件通过、2 个文件跳过；820 项通过、15 项跳过，0 失败。
- PowerShell 显式真实浏览器验证：
  ```powershell
  $env:CROSSCHECK_REAL_BROWSER='1'; pnpm vitest run packages/tools/test/browser-standard.real.test.ts packages/tools/test/browser-standard.test.ts packages/tools/test/browser-standard-session.test.ts packages/tools/test/evidence.test.ts packages/tools/test/evidence-review.test.ts packages/tools/test/task8-presenter.test.ts packages/core/test/guards.test.ts
  ```
  结果：7 个文件、131 项全部通过；其中新增真实 Chromium 用例 8 项，新增标准单元/会话用例 8 项。
- `git diff --check`：成功。
- CLI e2e 测试内部执行生产/测试 harness 构建并使用假模型；未另行宣称完成后续 CLI 浏览器闭环任务。

### 真实 Chromium 验证内容

- 临时 loopback 页面执行 navigate/fill/click/select/press/wait/observe；使用 CSS、role、text、testId、XPath 定位。
- 不在基站端口内的页面跨端口 fetch 成功，且真实服务器计数增加；无网络守卫、代理或 CDP 拦截。
- env 引用只在宿主读取，填入值登记为已知 secret；普通 fill 也登记，输出不含原始值。
- PNG 独立解码 IDAT、还原滤波后断言实际 RGB 像素；批准 selector、已知 secret、canvas、SVG、iframe、敏感输入均为 `[255,0,255]`，未遮罩空白区域仍为 `[255,255,255]`。不是通过 PNG 不含明文证明遮罩。
- DOM、console、HAR 和落盘目录不含密码/批准 selector/已知 secret 哨兵；DOM 保留可用文本与结构化定位信息。
- 响应/请求失败事件、250 条 console、220 个真实请求覆盖事件限额、省略标记与 flush 期间新增事件。
- 两个宿主独立 context，不共享 Cookie；`acceptDownloads:false` 导致真实下载失败，不接受自动文件下载。
- 未命中定位器失败仍有前后 DOM/截图及网络/console 证据；进行中取消、前置采证取消和预取消均验证资源关闭；重复 close 幂等。
- 截图跨 case ID 读取被拒绝、篡改文件摘要被拒绝、删除文件被拒绝；伪造 `complete:true` 不能入库。
- 启动失败与 context 关闭失败的部分资源清理在 Playwright 边界注入测试，真实取消另行验证。

## 交付接口

- `launchBrowserSession({signal, headless?}) → {browser, context, page, close}`：标准 `chromium.launch/newContext`，每宿主独立、禁自动下载，启动失败清理部分资源，幂等 await close。
- `BrowserHost({baseURL,evidence,redactor,screenshotMasks?,env?,launch?})`：参数与简报一致，无额外网络模式或浏览器 args。
- `getSession(signal)`：仅宿主调用，供后续认证使用；模型工具不暴露 session/context。
- `perform(action,meta,signal) → {evidenceIds,summary}`；动作串行，失败通过 `BrowserOperationError(kind,message,evidenceIds)` 保留观察。原始 Playwright 诊断不返回模型，存储异常不降为业务成功/可忽略错误。
- `createBrowserTools(host,nextMeta)`：仅一个 `browser_action`，category 为 browser；严格 schema，拒绝 evaluate、缺失 click locator、额外路径和双重 fill 输入，role 使用 Playwright 正确类型。
- `capturePage` 的私有 WeakMap 绑定真实 PNG 与同一 redactor；仓库只接受能力对象，不信外部 bytes 或 complete 标志。能力未从 tools index 暴露。
- `EvidenceStore.readTextEvidence` 新增 dom；`readScreenshotEvidence(id)` 根据当前 attempt 索引、归属、路径、摘要与 PNG 文件头读取 `{id,type,bytes,mediaType}`。
- `screenshotMasks` 为 optional，没有默认空数组；测试确认旧审批 hash 不变、修改 selector 必使 hash 改变。
- 现有文本 presenter 对 dom 明确拒绝，保留原行为边界，等待 Task 2 接入；未提前修改 agent 的多模态接口。

## 清理与自审

- 删除已授权且无后续消费者的 `browser/network-proxy.ts`、`browser/request-guard.ts`，以及旧代理、CDP guard、admission、进程树终止专用测试四个文件。
- 移除 hostPortAllowed 导出和专用测试；恢复基线研究前的 HTTP 私有 hostAllowed 实现，原 HTTP/DB 守卫测试回归通过。
- 无 OS 网络沙箱、Job Object、自 spawn、WT/RTC 禁用研究，无可选第二网络模式。
- 事件回调不写盘，不启动未跟踪异步正文任务；flush/close 写入全部 await；取消回调只触发并保留同一清理 promise，调用者可通过 close 等待并获得清理失败。
- 自审重点：取消与串行队列相互等待、启动半成品清理、普通存储异常传播、flush 数据交换、HTTP-only 冷启动、敏感输入定位、归属/哈希检查。已通过对应测试修复上述实际发现。
- 遵守不派代理要求，本次为单执行者自审，不声称做过独立代理审查；后续协调者可按本报告和提交执行独立审查。

## 明确局限与后续事项

- 浏览器用于用户信任的测试项目，不提供页面网络隔离；重定向、页面自身网络能力不受旧 allowedHosts 限制。HTTP/DB 独立工具仍遵守各自守卫。
- 网络证据仅采集有限 URL、方法、响应状态、类型、失败元数据；请求/响应头、Cookie、正文在源头省略，包括 JSON、文本与二进制。HAR 明确写 omitted，不能据此声称已读取完整业务响应。该方案避免无界、流式或压缩正文内存消耗。
- 每会话网络记录及 console 各 200 条，后续事件只累计省略数；单条 console 超 8192 字符整体省略；DOM 最多 2000 节点、节点文本最多 2000 字符，超限整页遮罩并标记 incomplete。
- 所有输入控件、图片/视频/音频、iframe/canvas/svg/object/embed、可识别 shadow/custom element 与背景图保守遮罩；可能遮住非敏感内容。结构化 DOM 不输出原始 HTML。截图为当前视口，不声称覆盖整页、弹窗或每个后台 page。
- DOM 探测与截图不是页面脚本暂停后的原子事务，信任测试页面的稳定性；不承诺对恶意持续变换 DOM、隐藏 shadow 内容或未知字体像素编码实现数学意义的全秘密识别。动态密钥必须在采集前登记，后登记不能回溯清洗已落盘 PNG。
- 截图真实哈希与归属读取已交付，但模型 image part、共享认证、runner 审计/预算接线由后续任务实现，本次不声称其已完成。
- 未执行真实 PostgreSQL、最低 Node 版本矩阵、真实厂商模型联调；默认 15 个跳过中包括新增 8 项真实浏览器测试与既有 7 项数据库测试；8 项浏览器已用显式开关另行通过。
