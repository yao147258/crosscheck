# 变更影响分析实施计划

> 执行技能：superpowers:subagent-driven-development；每项先测试失败、再实现、再审查。

**目标：** 新增只读 `crosscheck impact`，用 Git 基线解释需求与笔记变更对画像和用例的级联影响。

**架构：** core 提供差异模型、依赖图和确定性传播；CLI 安全读取 Git 和磁盘快照并输出文本或 JSON，不加载模型上下文。

**技术栈：** TypeScript、Node、已有 yaml/zod、Vitest、pnpm；不增加依赖。

**规格：** `docs/superpowers/specs/2026-11-19-impact-analysis-design.md`。

## 全局约束

中文说明/注释；在 impact-analysis worktree 实现；不自动 commit、merge、push。命令只读，不更改审核、生成、执行门禁。默认 HEAD，支持 --since、--json、--project 和 /impact。磁盘为当前比较目标，不单独比较暂存区。输出不能包含正文或配置值；缺口2，宿主3，完整0。

## Task 1：纯差异模型

文件：core/src/impact/{types,compare}.ts、core/test/impact.test.ts、core/index.ts。

- [x] 写新增/修改/删除、键顺序、case集合、文本换行、特殊键、输入不变和invalid不造假测试。
- [x] 运行定向测试确认失败。
- [x] 实现compareSnapshots，复用canonicalize，输出仅key/kind/字段路径。
- [x] 运行测试、typecheck并独立审查。

## Task 2：依赖与传播

文件：core/src/impact/{dependencies,analyze}.ts、core/test/impact-analysis.test.ts。

- [x] 写covers、actor、fixtures、画像引用、旧边删除、循环、跨模块、新旧图隔离和缺口测试。
- [x] 运行失败后构图与实现analyzeImpact；新旧图独立遍历再合并最短原因链。
- [x] notes及自然语言使用未知时保守possible；显式关系definite；不把确定依赖等同确定失败。
- [x] 验证覆盖建议、重复ID和缺失引用；独立审查。

## Task 3：Git与快照读取

文件：cli/src/impact/{git,snapshot}.ts、cli/test/impact-git.test.ts。

- [x] 临时Git仓库测试HEAD/历史提交、嵌套项目、worktree、Unicode、未跟踪、磁盘与index差异、缺文件/坏YAML/链接/限额。
- [x] Git使用execFile参数数组，先解析commit OID，再用ls-tree和cat-file读取普通blob；不执行外部diff/过滤器。
- [x] 读取config文档并集、notes、七画像和模块并集，使用既有schema和安全路径校验；区分missing/invalid/present。
- [x] 单文件1MiB、需求2MiB、每侧16MiB/2000文件；严格UTF-8；复核并发变化；测试、类型检查、审查。

## Task 4：CLI与会话

文件：cli/src/impact.ts、impact/report.ts、args.ts、main.ts、session.ts和相应测试。

- [x] 先写参数、退出码、JSON、slash分发/补全和只读测试。
- [x] 实现命令编排；JSON为单个版本化对象；文本分区输出实际变更/显式影响/可能影响/缺口。
- [x] 输出基线OID、原因链和限制；原始错误与正文不进入报告。
- [x] 支持取消，不加载模型配置；审查并运行定向回归。

## Task 5：交付验证

- [x] 更新README、CLI README、manual-integration，说明Git跟踪要求、使用示例和退出码。
- [x] 真实Git端到端验证条款精确影响和笔记保守影响；比较前后内容及git状态证明只读。
- [x] 执行 pnpm test、pnpm typecheck、pnpm build 和构建产物 smoke test；默认并发测试仍有既有时序失败，单 worker 全量通过。
- [x] 独立完整审查、修复验证、git diff --check。
- [x] 保留worktree和未提交实现，汇报使用方式、验证证据、限制。
