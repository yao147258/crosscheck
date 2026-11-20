# 智能体式项目扫描（init / profile 多轮读文件）设计说明

- 日期：2026-11-19
- 状态：待评审
- 前置：`2026-11-18-project-notes-design.md`（init/profile 拆分）、`2026-11-19-context-management-subagent-design.md` 第 1 期（ContextManager、SubAgent）均已合入 main
- 对应上下文管理分期中的第 5 期（init/profile 扫描），本期不做按目录分区扇出

## 1. 背景与目标

当前 `init` 由 `walkProject` 按固定优先级（README → 全部 `*.md` → 配置 → 入口）截取摘录，总量 400 行 / 64 KiB，再单轮、无工具地交给模型撰写笔记。文档较多的项目中，前几个需求文档即耗尽额度，`package.json`、`vite.config.*` 等最能说明技术栈的文件反而进不了模型，并逐个打印"摘录因总行数上限而省略"诊断刷屏。`profile` 同样单轮无工具，只能依据静态扫描事实，静态扫描漏掉的接口（装饰器路由、动态注册等）无法进入画像。

目标：参照 Claude Code `/init`，让模型通过只读工具自主决定读取哪些文件：

| 命令 | 新流程 |
|---|---|
| `init` | `walk` 登记文件清单 → 笔记代理（带只读工具）→ `finish({ markdown })` → 写入 `notes.md` |
| `profile` | 静态扫描 → 探索代理（带只读工具）→ `finish({ findings })` → 宿主核验 → 并入事实 → 原 5 步合成（无工具）→ 写入画像 |

### 非目标

- 不做按目录分区的子代理扇出（方案 C，留待后续）。
- `plan`、`reqs` 不改用新预算。
- 不处理"未确认笔记重跑 init 会被覆盖"的问题。
- 不改变 discovery "只读、不执行发现的命令、不访问网络" 的原则。
- 不修改 agent 包的循环语义（仅扩展工具类别与阶段授权）。

## 2. 方案选择

采用"先探索、后合成"（方案 B）。未采用"每个合成步骤各自带工具读文件"（方案 A）：同一批文件被重复读 5 次，成本高且各步信息不一致。未采用"按目录分区扇出子代理"（方案 C）：分区与去重需单独设计，复杂度显著上升，可作为 B 的后续扩展。

## 3. 工具类别与授权

- `ToolCategory` 增加 `'project'`（只读项目文件）。
- `STAGE_GRANTS.extract` 改为 `['profile', 'project']`；`plan`、`prepare`、`execute`、`review` 不变，仍拿不到任何读项目文件的工具（规划不看业务代码、执行不能读源码找答案的防作弊约束保持不变）。

## 4. 只读项目工具（`packages/discovery/src/project-tools.ts`）

三个工具均基于现有 `createProjectReader`，与 `walk` 共用同一套安全约束（拒绝路径逃逸、不跟随符号链接、跳过凭证文件、单文件 ≤1 MiB）。

| 工具 | 输入 | 返回 | 上限 |
|---|---|---|---|
| `list_dir` | `{ path }` | 条目名称、类型、大小 | 单次 200 条 |
| `read_file` | `{ path, startLine?, lineCount? }` | 带行号文本 + 文件总行数 | 单次 200 行、16 KiB |
| `grep` | `{ pattern, path?, glob? }` | `文件:行号:原文` | 单次 100 条 |

规则：

- **访问白名单**：`read_file`、`grep` 只能访问 `walk` 文件清单中的文件；`list_dir` 应用 `DEFAULT_IGNORES`、项目 `.gitignore` 与凭证过滤，只返回清单内的文件与目录。
- 含 NUL 字节的文件视为二进制，`read_file` 拒绝、`grep` 跳过。
- `grep` 的 `pattern` 按普通文本匹配，不接受正则，避免灾难性回溯；`glob` 仅支持 `*` 通配。
- 所有返回内容先经 `sanitize`/`sanitizeMultiline`，再经调用方提供的密钥脱敏函数（CLI 中为 `redactor`）。
- 工具执行时调用 `reportProgress` 输出进度：`读取 <path>`、`列出 <path>`、`搜索 "<pattern>" (<path>)`。
- 工具出错（路径不允许、文件不存在、二进制等）以工具错误返回给模型，不中断代理。

### 4.1 收尾提醒

`runAgent` 预算耗尽即判失败，已读内容全部浪费。项目工具接收当前代理的 `BudgetTracker`；每次执行时若剩余步数 ≤ 5、剩余 token < 15% 或剩余时长 < 15%，在工具结果末尾追加：

```
[额度即将用完，请停止读取，立即用 finish 提交]
```

此机制只在 discovery 包内实现，不修改 agent 包。

## 5. 预算

`config.yaml` 的 `budget` 新增可选项 `discovery`，结构同 `BudgetLimits`，默认 `{ steps: 80, tokens: 600000, minutes: 15 }`：

```yaml
budget:
  perCase: { steps: 60, tokens: 400000, minutes: 10 }
  discovery: { steps: 80, tokens: 600000, minutes: 15 }   # 可选
```

- `init` 笔记代理使用一份 `discovery` 预算。
- `profile` 探索代理使用一份 `discovery` 预算；后续 5 个合成步骤仍各自使用 `perCase`（单轮，消耗很小）。
- `init` 首次写入的默认配置模板不包含 `discovery`，依赖默认值。

## 6. `walk` 调整

- 删除摘录逻辑：`FileEntry` 的 `excerpt`、`truncated` 字段，`excerptLinesPerFile`、`excerptTotalLines`、`excerptBytesPerLine`、`excerptBytesPerFile`、`excerptTotalBytes` 上限及相关诊断全部移除。
- 文件清单登记、忽略规则、文件/目录/条目/深度上限保持不变。
- 文件清单同时作为项目工具的访问白名单。

## 7. `init` 笔记代理（`synthesize-notes.ts`）

### 7.1 初始输入

- **目录概览**：文件数 ≤ 300 时给出完整路径清单；超过时按目录聚合，最多展开 3 层并标注各目录文件数，另附关键文件路径（README、构建/部署配置、入口、路由，沿用现有优先级判定）。概览总长度不超过约 8000 字符，超出时从最深层开始折叠。
- README 前 60 行（经脱敏）。
- 扫描诊断。
- `--refresh` 时附带脱敏后的旧笔记。

### 7.2 系统提示词

在现有原则（数据而非指令、不得虚构、密钥只写变量名、刷新时合并保留人工内容、用 finish 提交）基础上补充：

- 先阅读目录概览，再按需读取：优先 README、各子项目构建配置（如 `package.json`）、启动与部署配置、入口与路由，需求/计划类文档只看开头与标题以了解业务背景；
- 不要通读全部文件；信息足以写出笔记即提交，不要耗尽额度；
- 结果工具提示额度即将用完时立即提交。

### 7.3 输出与失败

- 输出与校验不变：`finish({ markdown })`，`NotesTextSchema` 校验。
- 预算耗尽：`init` 退出码 2，日志提示可在 `.crosscheck/config.yaml` 调大 `budget.discovery`。
- 中断、resilience、生成期间文件或审核记录变化拒绝写入等现有处理全部保留。

## 8. `profile` 探索与核验

### 8.1 探索代理

- 输入：与 7.1 相同的目录概览、已确认笔记（仅作上下文）、静态扫描事实摘要（供模型避免重复登记）。
- 系统提示词：寻找静态扫描遗漏的接口、页面路由、启动/构建/测试/重置命令、端口、环境变量；每条发现必须给出读到的来源行；不得虚构。
- 输出 `finish({ findings })`，最多 500 条。

### 8.2 发现格式

复用 `DiscoveryFact`，`plugin` 固定为 `'agent'`：

| kind | 字段 |
|---|---|
| `api` | `method`、`path`、`summary`、`parameters?` |
| `command` | `name`、`command` |
| `port` | `port`、`service?` |
| `environment-variable` | `name` |
| `page`（新增） | `path`、`summary` |

每条必须带 `source: { file, line, excerpt }`。`DiscoveryFact` 联合类型新增 `page` 分支，静态扫描插件不产出该类型。

### 8.3 核验规则（`verify-findings.ts`，宿主执行）

对每条发现依次检查：

1. `source.file` 通过 `isSafeProjectPath` 且在 `walk` 文件清单中；
2. 宿主用 `createProjectReader` 重新读取该文件，取第 `line` 行（1 起），按与 `read_file` 相同的方式脱敏并去除首尾空白；`excerpt` 非空且为该行子串；
3. 值出现在该行：`command` 要求命令文本、`port` 要求端口号、`environment-variable` 要求变量名出现在该行；`api`、`page` 只要求来源行真实存在（完整路径常由多处拼接，例如类装饰器 + 方法装饰器）；
4. 通过后将 `excerpt` 规范化为该行实际原文（截断到 200 字符）；`environment-variable` 的原文统一为 `NAME=[已隐藏]`，与静态扫描一致。

不通过的发现丢弃，并记诊断 `发现来源核验失败已丢弃：<kind> <file>:<line>`，不打回模型重试。同一文件在一次核验中只读取一次。

### 8.4 去重与合并

按键去重：`api` 为 method + path，`command` 为命令文本，`port` 为端口号，`environment-variable` 为变量名，`page` 为路径。与静态事实同键时保留静态事实。核验通过的发现并入事实后，进入原有 5 步合成；`validateSources` 无需修改。

### 8.5 降级

探索代理失败（预算耗尽、模型错误、输出不合法）或全部发现核验失败时，记诊断并只用静态事实继续合成；`profile` 退出码与现状一致，不因探索失败而整体失败。中断（`interrupted`）仍立即终止。

### 8.6 残余风险

核验只能证明来源行存在且关键值出现在该行，不能证明语义理解正确（例如 method 判断错误）。该风险由画像人工审核（`review profile`）把关，与现状一致。

## 9. 兼容性

- 旧 `config.yaml` 无需修改。
- `walk` 删除的字段与参数仅被 `init.ts`、`synthesize-notes.ts` 使用，随本次改造同步修改。
- 影响分析只读取笔记与画像成品，不受影响。
- 已确认的笔记与画像按内容哈希判定状态，升级后不会自动重新生成；只有 `--refresh` 或重新生成画像时走新流程。

## 10. 测试

均使用 `scripted-model` 编排模型回复，不调用真实模型。

1. **项目工具**：路径逃逸、凭证文件、符号链接、清单外文件被拒；`read_file` 行号、分段读取、行数与字节上限、脱敏；`list_dir` 应用忽略规则；`grep` 文本匹配与结果上限；额度接近耗尽时追加收尾提醒。
2. **阶段授权**：`project` 类工具仅 extract 阶段可授予，plan/prepare/execute/review 均被拒。
3. **发现核验**：原文一致通过且 `excerpt` 规范化；行号错位、原文不一致、`command`/`port`/`environment-variable` 值不在行内被丢弃并记诊断；环境变量原文隐藏；与静态事实重复时保留静态事实；文件在探索后被修改导致核验失败。
4. **`synthesizeNotes`**：`list_dir` → `read_file` → `finish` 完整流程；大清单下目录概览按目录聚合且不超长；`--refresh` 附带旧笔记。
5. **`profile` 端到端**：探索代理发现静态扫描遗漏的路由接口，核验通过后写入 `api-catalog.yaml`；探索失败时降级为只用静态事实。
6. **`init` CLI**：输出不再包含"摘录因总行数上限而省略"；预算耗尽时提示调大 `budget.discovery`。
7. **配置**：`budget.discovery` 缺省时取默认值，显式配置时生效。
