# 计划 1 遗留事项（供计划 2/3 参考）

计划 1 执行和终审中延期的问题，以及执行时做出的裁定。

## 必须在计划 2 落地证据采集 / 数据库工具前处理

- **数据库工具**
  - 用只读账号连接，并在只读事务（`SET TRANSACTION READ ONLY`）中执行。
  - 设置 `statement_timeout` 和 `lock_timeout`：`FOR SHARE`、`pg_advisory_lock`、`GET_LOCK` 都能通过 SQL 守卫。
  - 驱动禁用多语句，查询先过 `checkReadonlySql` 再参数化。守卫会拒绝 `$1`、`[` 和 `]`，所以要提示代理用双引号标识符。
  - `query_to_xml` 这类在字符串里执行 SQL 的函数能绕过关键字检查，只能靠只读账号兜底。
- **HTTP 和浏览器工具**
  - 每一跳重定向都要过 `checkRequest`，禁止自动跟随到白名单之外。
  - 页面脚本发起的请求同样要拦截，用 `page.route`。
  - 方法覆盖（`_method`、`X-HTTP-Method-Override`）在工具层处理。
  - 规则 `GET /x/**` 拦不住 `HEAD` 请求。
- **脱敏**
  - multipart/form-data 正文目前没有脱敏。
  - SPA 哈希路由 `#/cb?token=…` 里的令牌没有脱敏，而且 URL 会被改写坏。
  - 相对 URL 不处理查询参数。
  - 子串规则会误伤用量字段（`inputTokens` 等）和 `passwordPolicy` 子对象，可以考虑数值和布尔值不脱敏。
  - `session`、`sid`、`sessionId` 不在默认字段里。
  - 需要补一个集成测试：拿一份完整 HAR 落盘，断言其中不含令牌原文。
- **工具约定**：工具必须响应 `ctx.signal`，否则时长预算无法硬截止。

## 计划 2 中顺手处理

- **ArtifactStore**
  - 写入失败时清理临时文件，带 UUID 的 `.tmp` 文件会越积越多。
  - YAML/JSON 语法错误、保存时的 `ZodError` 统一包装成 `ArtifactError`，映射到退出码 3。
- **models**
  - fallback 缺密钥时，应跳过 fallback 并给出警告，现在会让整个角色解析失败。
  - openai-compatible 没写 `apiKeyEnv` 时给出警告。
  - 补测试：真实工厂的分支（缺 baseURL、ollama 默认地址）。
  - `vendorWarnings` 还要考虑 fallback 和相同 baseURL 的情况。
- **resilience**：默认 `sleep` 正常到期后，要移除挂在 signal 上的 abort 监听器。
- **runAgent**
  - 同一轮里 `[finish, finish]` 只计 1 次不合格。
  - 工具输入是非法 JSON 时，明确提示“参数不是合法 JSON”。
  - 从工具循环中途返回时，给末尾的 tool-call 补上占位结果，否则续跑对话会 400。
  - 入口处统一校验工具名唯一性和格式。
  - 用真实模型联调时，关注纯文本回复被计为不合格的比例（`toolChoice: 'required'` 已移除）。
- **门禁**：`assertProfileApproved` 应由 core 自行枚举画像文件清单。
- **白名单**：条目格式校验提前到 `GuardrailsSchema`，加载时就报错。
- **其他**
  - 费用展示时做舍入。
  - `verdict.ts` 补中文注释。
  - 改正测试名“signal 已中止时立即抛出，不调用模型”（实际会调用 1 次）。
- **构建**：目前 `exports` 指向 .ts 源码，发布前要补构建步骤。CLI 包声明 `engines.node >= 20`。

## 计划 3 前必须定方案

- **用例确认没有绑定所覆盖条款的内容。** 条款改后重新确认，旧用例仍然处于“已确认”状态。规格 §5.3 没覆盖这种跨条目失效。建议确认用例时把所覆盖条款的哈希一并纳入。

## 执行中做出的裁定（规格未明确处）

- 结构化输出用内置 `finish` 工具加 zod 校验，没有用 `Output.object`。
- ollama 通过 `@ai-sdk/openai-compatible` 接入。
- 开发环境要求 Node ≥ 22.12（因为 vitest 5）；规格的 Node ≥ 20 指发布后的运行时。
- FAIL 与 BLOCKED 同时出现时退出码取 1。
- **SQL 守卫**：字符串和标识符之外，出现以下任意内容一律拒绝：
  - 注释、`\r`、反斜杠、`#`、`$`
  - `[`、`]`
  - `U&`、`UESCAPE`
- **URL 守卫**
  - 先规范化路径再匹配，不区分大小写。
  - 白名单条目严格校验格式，通配符条目不能带端口。
- **脱敏**
  - 默认字段包含常见令牌字段。
  - 键名规范化后比较，并有子串规则：`password`、`token`、`secret`、`apikey`。
- **runAgent**
  - 移除了 `toolChoice: 'required'`。
  - 同一轮里出现 finish 或 report_blocked 时，其他工具不执行。
  - 时长预算硬截止，并且每次记账后都检查是否超额。
- **重试**
  - 中断和超时不重试。
  - 不可重试的 API 错误直接切换备用模型。
