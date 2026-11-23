# 需求文档目录与笔记发现：延期项清单

日期：2026-11-22
状态：未处理，仅作记录

来源：`2026-11-20-requirement-docs-discovery` 实施过程中的任务评审与最终整分支评审。
这些问题经评审判定**不阻塞合并**，已随分支合入 `main`（`2022a41`）而未修复。

- 设计：`docs/superpowers/specs/2026-11-20-requirement-docs-discovery-design.md`
- 计划：`docs/superpowers/plans/2026-11-20-requirement-docs-discovery.md`

说明：清单整理自评审报告，文件与行号是评审当时的位置，修改前请以当前代码为准。

## A. 建议优先跟进（特定情况下给出错误或误导结论）

均在 `impact` 一侧，可以合并成一次改动。

| # | 问题 | 位置 | 影响 | 建议 |
|---|---|---|---|---|
| A1 | `impact` 当前侧的磁盘列目录没有传 `onDiagnostic` | `packages/cli/src/impact/snapshot.ts`（当前侧 `createDiskDocLister(...)` 调用处） | 跳过符号链接、单目录超过 5000 条被截断时都不提示。截断时磁盘侧按 `opendir` 顺序截断，Git 侧不截断，第 5000 条之后的 `.md` 会被误报成 `deleted`。需求目录要有 5000 个以上条目才会触发。 | 传入诊断回调，把截断转成 `restricted-input`，让结果标为不完整 |
| A2 | 当前侧磁盘 I/O 故障被降级 | `snapshot.ts` 展开处的 catch；`packages/discovery/src/files.ts` 的 `list` 对 EACCES 抛普通 `Error` | 目录读取失败变成"分析不完整"（退出码 2），而同一错误在 `readCurrent` 里是 `ImpactHostError`（退出码 3）。 | 让磁盘 lister 的宿主类错误能被识别并上抛；`reqs` 侧同理（见 B2） |
| A3 | 当前侧目录写错时没有任何提示 | `snapshot.ts`（展开用了 `allowEmpty`） | 例如把 `docs/` 写成 `dcos/`，既没有节点也没有诊断；显式文件写错倒有 `missing-document`。 | 两侧展开结果都为空时给一条诊断 |
| A4 | 需求范围变化提醒不覆盖笔记来源 | `packages/core/src/impact/analyze.ts:102` | 只在 config 的 `requirementsDocs` 变化时提示"需求文档范围发生变化"。清单来自笔记时，改小节不触发该提醒（笔记本身的变更仍会列出）。 | 清单来源为笔记时，笔记小节变化也触发该提醒 |
| A5 | Windows 目录大小写不一致 | `packages/cli/src/impact/git.ts` 的 `listTreeFiles` 与磁盘 lister | 把 `docs/` 写成 `Docs/`：磁盘不区分大小写能列出，Git 的字面 pathspec 区分大小写，一个也找不到，所有文档被报成 `added`。显式文件路径在本次改动前就有同样问题。 | 展开前校正大小写，或两侧都按区分大小写处理并给诊断 |
| A6 | 100 个文件上限口径不一致 | `snapshot.ts`（对每个条目单独调用展开） | `reqs` 按全部条目合计，`impact` 按每个条目单独算。配两个各 60 个文件的目录，`reqs` 报错，`impact` 照常接受。 | `impact` 先合并条目再展开，使上限按总数计算 |

## B. 低风险（体验与边缘情况）

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| B1 | 围栏代码块里以 `#` 开头的行被当成标题 | `packages/core/src/schema/notes.ts`（`parseNotesRequirementDocs`） | 会让"需求文档"小节提前结束；按约定写的笔记里几乎不会出现，最坏结果是少列几个文档，且有人工审核兜底。 |
| B2 | `reqs` 展开阶段的 I/O 错误按退出码 2 处理 | `packages/cli/src/reqs.ts` 展开处 catch | 严格说应属宿主错误（3）。计划就这样规定，偏保守，不会产出错误结果。 |
| B3 | `impact` 展开失败的诊断 `file` 为空 | `snapshot.ts` 展开处 catch | 看不出是哪个目录条目失败；可填 `parseDocEntry(entry).path`。 |
| B4 | 磁盘遍历没有文件数早停 | `packages/discovery/src/requirement-docs.ts`（`createDiskDocLister`） | 100 个上限要等整棵树列完才检查；时间开销有界（单目录 5000 条、深度 8），结果正确。 |
| B5 | 忽略目录区分大小写 | `requirement-docs.ts`（`SKIPPED_DIRS`） | Windows 上的 `Node_Modules` 不会被跳过；磁盘与 Git 两侧行为一致，不会造成 `impact` 分歧。 |
| B6 | 子目录截断的诊断不带路径 | `requirement-docs.ts` | 只是诊断可读性。 |
| B7 | `listTreeFiles` 登记了目录下所有 `.md` | `git.ts` | 含 `node_modules` 与超深度文件，大目录占内存；受 16 MiB 列表预算约束，且 `raw()` 要求 `candidates.has`，不影响正确性。 |
| B8 | 删除 `scope` 后的副作用 | `packages/core/src/impact/dependencies.ts` | `pages`、`api-catalog` 的 `sources` 现在会连到所有已解析的文档节点，`budget.spend` 计数也变了；没有测试覆盖。 |
| B9 | 笔记提前解析改变了顺序 | `snapshot.ts` | 预算消耗与诊断先后顺序变化（笔记诊断排在 `missing-config` 之前）；目前没有测试依赖它。 |
| B10 | 裸 `/` 目录条目的报错变了 | `requirement-docs.ts` | 从"不能是项目根目录"变为"路径不安全"，两者都是错误，新说法更准确。 |
| B11 | 入口目录是符号链接或普通文件 | `reader.list` | 即使用了 `allowEmpty` 也抛错，被 `impact` 转成 `restricted-input` 诊断；属于预期的"失败即关闭"，记录备查。 |

## C. 测试缺口

- 项目位于仓库子目录（`prefix` 非空）的 `impact` 用例。读代码确认路径处理正确，但没有测试守护。
- 宿主错误（`ImpactHostError`）不被展开处的 catch 吞掉的回归测试（需要模拟 git 进程故障）。
- 超过 100 个文件触发的"分析不完整"诊断。
- `impact` 基线中符号链接、子模块被跳过。
- 两侧清单来源不同（一侧 config、一侧笔记）。
- `impact` 基线目录缺失时"不产生诊断"的断言（现在只断言了识别为 `added`）。
- `reqs` 在 CLI 层的展开错误：超过 100 个文件、`../x/` 不安全目录、笔记来源下缺失显式文件应退出 3、`notes.md` 非 UTF-8。
- 展开函数的"注入列目录函数"测试没有覆盖深度过滤与 CRLF 路径。
- `requirement-docs.test.ts` 中 `rejects.toThrow()` 没有断言错误类型；`reqs` 绝对路径用例只断言消息含"路径"。

## D. 提示词、测试风格与文档

- `init` 的提示词测试只固定措辞，不验证模型行为（计划规定如此）。
- 提示词示例里的"依据"可写成"依据（一句话说明）"，避免模型照抄。
- `synthesize-notes.test.ts` 中 `await import('../src/index')` 可并入顶部静态导入。
- README 与 `docs/manual-integration.md`：把"config 非空始终优先"挪到笔记兜底说明之前，语序更自然。

## 已处理（不属于延期，仅备查）

最终评审中的两项已在合并前修复，不要重复处理：

- 显式绝对路径被静默改写成项目相对路径（`8757cd8`）。
- 文档补充"`impact` 不要求笔记已确认"（`2022a41`）。
