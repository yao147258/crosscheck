# 计划 3：独立 discovery 实施计划

> **执行要求：**使用 superpowers:executing-plans 按任务执行，逐项记录验证；未经用户要求不创建提交。

**目标：**提供不依赖计划 2 的本地只读发现、静态扫描与 OpenAPI 解析。

**架构：**新增独立 `@crosscheck/discovery` 包。插件只接收受限读取器，输出带来源的事实和诊断，不生成正式画像。文件边界与解析器分离，不改变 core/models/agent。

**技术栈：**TypeScript、Node.js ≥ 22.12、ESM、pnpm 9、yaml 2、vitest。

**设计依据：**`docs/superpowers/specs/2026-11-13-plan3-independent-design.md`

## 全局约束

- 注释、错误和文档使用中文；测试不联网、不消耗真实 token。
- 不执行命令、不读取真实 `.env`、不写被测项目、不修改计划 2 协议、不提交。
- 每个文件职责单一；测试先失败再实现。

## 文件职责

- `packages/discovery/package.json`：工作区包与 yaml 依赖。
- `src/types.ts`：来源、事实候选、诊断、插件输入输出。
- `src/files.ts`：受限读文件、路径/大小/凭证文件限制。
- `src/discover.ts`：顺序运行插件、验证插件 ID、传播取消与归集诊断。
- `src/sanitize.ts`：候选文本的凭证/URL 清理。
- `src/static-scan.ts`：已知清单静态提取。
- `src/openapi.ts`：OpenAPI 解析与局部引用。
- `src/index.ts`：统一导出。
- `test/{files,discover,static-scan,openapi}.test.ts`：临时目录下的行为测试。

## Task 1：读取边界与插件执行

**接口：**`createProjectReader(projectRoot:string): ProjectReader`，`readText(file:string,signal?:AbortSignal):Promise<string|undefined>`；`discover({projectRoot,plugins,signal?}):Promise<DiscoveryResult>`。`DiscoveryPlugin={id:string,scan(ctx:DiscoveryContext):Promise<DiscoveryResult>}`，`DiscoveryContext={files:ProjectReader,signal?:AbortSignal}`。结果 `{facts:DiscoveryFact[],diagnostics:DiscoveryDiagnostic[]}`，每项带 plugin/source。

- [ ] 写失败测试：临时项目读正常文件、缺文件为 undefined、越界/绝对路径/真实 .env/超大文件拒绝；符号链接不能泄露文件；重复插件 ID 拒绝；插件异常产生不泄露异常正文的诊断；取消传播。

```ts
const reader = createProjectReader(root);
expect(await reader.readText('README.md')).toBe('项目');
await expect(reader.readText('../secret')).rejects.toThrow();
await expect(reader.readText('.env')).rejects.toThrow();
expect(await reader.readText('missing.md')).toBeUndefined();
```

- [ ] 运行 `pnpm exec vitest run packages/discovery/test/files.test.ts packages/discovery/test/discover.test.ts`，确认缺失功能失败。
- [ ] 创建包与上述 types/files/discover/index：用 realpath/lstat 确认项目内非符号链接普通文件，限制 1 MiB；以相对 POSIX 路径表示来源。插件只按顺序执行，ID 唯一；异常诊断不复制任意异常正文；signal 中止直接抛出。
- [ ] `pnpm install --offline`，重新执行定向测试和 `pnpm typecheck`；用测试覆盖错误边界，不通过放宽路径限制解决失败。

## Task 2：静态扫描事实

**接口：**`staticScanPlugin:DiscoveryPlugin`。事实使用判别联合：project（ecosystem/name）、command（name/command）、port（port/service?）、environment-variable（name）、api（method/path/summary/parameters/servers）。每项 `{plugin,source:{file,line,excerpt}}`；无 approved 字段。

- [ ] 写失败测试，固定手工期望：package scripts/dependencies、README 启动候选、pom 标识、Compose ports、`.env.example` 键名。断言输出无内联 token/密码/URL 凭证，script 不产生 marker 文件，真实 `.env` 不被读，重复调用结果稳定，非法格式保留其他文件的结果，取消不被吞。

```ts
await writeFile(join(root, 'package.json'), JSON.stringify({
  name: 'shop', scripts: {dev: 'node server.js'}, dependencies: {express:'5'}
}));
const r = await discover({projectRoot:root,plugins:[staticScanPlugin]});
expect(r.facts).toContainEqual(expect.objectContaining({kind:'command',name:'dev',command:'node server.js'}));
```

- [ ] 定向测试观察失败。
- [ ] 实现有限文件名读取与逐文件解析，使用 yaml 的严格解析、拒绝重复键，env 只取变量名，pom 不解析实体，README 只取启动相关行；事实与来源摘录经过统一清理。未知结构返回中文诊断，绝不执行 script。
- [ ] 定向测试与类型检查通过。

## Task 3：OpenAPI 本地插件

**接口：**`openApiPlugin(files:string[]):DiscoveryPlugin`，固定 ID `openapi`。参数 `{name,in,required,type?}`；operation 参数覆盖同名同位置 path 参数，path 参数强制 required；仅允许文档内 JSON Pointer 引用；保留规范声明的 server URL/Swagger basePath，清理 URL 凭证和 query。

- [ ] 写失败测试：OAS3 YAML、Swagger2 JSON、operation 摘录/行号、局部参数引用与覆盖、3.1、外部引用不读取、循环引用诊断、无效版本/paths/参数、HTTP 方法白名单、畸形 YAML、取消。

```ts
await writeFile(join(root,'openapi.yaml'), 'openapi: 3.0.3\ninfo: {title: 商店, version: "1"}\npaths:\n  /items:\n    get:\n      summary: 商品列表\n');
const r = await discover({projectRoot:root,plugins:[openApiPlugin(['openapi.yaml'])]});
expect(r.facts).toContainEqual(expect.objectContaining({kind:'api',method:'GET',path:'/items',summary:'商品列表'}));
```

- [x] 定向测试观察失败。
- [x] 用 YAML Document（兼容 JSON）解析，LineCounter 提供真实行号；局部引用通过自身 JSON Pointer 解析并记录 visited；不解引用外部文件、不发网络请求。解析不完整 operation 时诊断且跳过该 operation，不冒充完整接口。
- [x] 全仓 `pnpm test`、`pnpm typecheck`、`git diff --check`；补 README 使用样例、支持范围和非安全沙箱说明。

## 当前验收状态

- 读取边界、插件执行、静态扫描、OpenAPI 本地解析均已实现并经多轮任务评审修复。
- 终审曾发现 4 项 Important（含 userinfo 路径、赋值/CLI 转义引号凭证、Compose 长语法端口校验与来源 AST 定位），均已修复并定向复审关闭。
- 复审后续发现的两类同类绕过也已修复：3 条及以上连续前导斜杠的 userinfo 绕过，以及 JSON/YAML 转义写法（`\/`、`/`、`\x2f`）绕过字面斜杠匹配。根因统一为"原始来源行文本的转义形式不含字面 `/`"，通过在 `sanitize()` 与 `clean()` 匹配前统一解码（`unescapeSlashes`）一次性关闭。全部修复均有 RED→GREEN 回归（详见包内测试）。
- 合入前主线程验证：20 个测试文件、362 项通过，`pnpm typecheck` 与 `git diff --check` 通过。
- 已知限制（非阻断）：脱敏为有限启发式规则；POM 为受限 XML 子集；被拒绝路径的查询串仍可能经同一行其它接口的 `source.excerpt` 保留（Minor）；OpenAPI 仅接口目录子集，非完整规范认证。
- 已知限制（非阻断）：requirements 服务运行中取消仅有入口预取消测试，运行中取消依赖 `runAgent` 既有中断覆盖。

## 自查

设计中的路径、隐私、事实/授权分离由 Task1/2 覆盖，本地接口提取与引用由 Task3 覆盖。输出不采用 Profile 或运行结果类型。三个任务的消费接口一致，不引入 plan2 API。
