# 任务 1 实现报告

## 实现内容

完成了 core 包的 5 项通用能力实现：

### 1. 处置记录（`packages/core/src/schema/disposition.ts`）
- `DECISIONS` 常量：定义三种决定类型 `confirmed_bug | false_positive | clause_issue`
- `DispositionSchema`：
  - 包含 `caseId`, `expectationId`, `decision`, `clauseId?`, `note`, `by`, `at` 字段
  - 使用 `superRefine` 验证：`clause_issue` 必须提供 `clauseId`，其他决定不能提供
  - `note` 默认值为空字符串
- `DispositionsFileSchema`：版本化容器，包含 `runId` 和 `items` 数组
- `upsertDisposition(file, item)`：同一 `caseId + expectationId` 只保留最后一次，不修改入参

### 2. 确认人解析（`packages/core/src/approvals/reviewer.ts`）
- `resolveReviewer(env?, userInfo?)`：
  - 优先从 `CROSSCHECK_REVIEWER` 环境变量读取（去除首尾空白）
  - 若环境变量为空，尝试从 `os.userInfo().username` 获取系统用户名
  - 两者都拿不到时抛出错误

### 3. 模块推断（追加到 `packages/core/src/schema/artifacts.ts`）
- `moduleOfId(id: string)`：
  - 从格式为 `<Module>-AC-<Num>` 或 `<Module>-TC-<Num>` 的 ID 中提取模块名
  - 支持字母、数字、下划线的模块名（如 `M09`, `shop_order`）
  - 无法解析时抛出错误

### 4. 画像逐文件读取（`packages/core/src/profile/profile-files.ts`）
- `ProfileFileState` 类型：区分缺失、校验失败、校验成功三种状态
- `readProfileFile(store, name)`：
  - 检查文件是否存在（返回 `present: false`）
  - YAML 解析失败时返回错误信息（`ok: false`）
  - 校验通过时返回带默认值的解析结果（`ok: true, value`）
- `readProfileFiles(store)`：并行读取所有 7 个画像文件，返回状态数组

### 5. 草稿合并与分区（`packages/core/src/workflow/drafts.ts`）
- `compareArtifactIds(a, b)`：按 ID 末尾编号升序排序，无法解析时按字符串
- `mergeDrafts<T>(approved, drafts, duplicateKey?)`：
  - 已确认条目原样保留
  - 草稿中 ID 冲突或（有 duplicateKey 时）内容重复的被丢弃
  - 返回 `MergeResult<T>` 包含 items（已排序）、kept、added、dropped
- `clauseDuplicateKey(clause)`：生成基于文件、行号、文本的重复检测键
- `partitionClauses(clauses, approvals)`：按确认状态拆分条款为已确认/草稿
- `partitionCases(cases, clauses, approvals)`：按确认状态拆分用例
- `coverage(clauses, cases)`：统计被覆盖和未覆盖的条款 ID
- `loadCoveredClauses(store, cases)`：按用例覆盖推断模块，加载这些模块的全部条款

## 导出更新（`packages/core/src/index.ts`）
添加了四个新的导出：
- `export * from './schema/disposition'`
- `export * from './profile/profile-files'`
- `export * from './approvals/reviewer'`
- `export * from './workflow/drafts'`

## TDD 证据

### RED：初始失败
```
$ pnpm vitest run packages/core/test/plan3-core.test.ts
RUN  v5.1.0 E:/crosscheck/.claude/worktrees/plan3-cli-tui

 ❯ packages/core/test/plan3-core.test.ts (12 tests | 12 failed)
   ❯ 处置记录 (2)
     × clause_issue 必须带 clauseId，其他决定不能带
     × 同一用例与预期后写覆盖先写
   ❯ resolveReviewer (3)
     × 优先使用 CROSSCHECK_REVIEWER
     × 否则使用系统用户名
     × 都拿不到时报错
   ❯ moduleOfId (1)
     × 从条款与用例 ID 推断模块
   ❯ readProfileFile (1)
     × 区分缺失、不合法、合法，并返回带默认值的解析结果
   ❯ mergeDrafts (2)
     × 保留已确认条目，丢弃 ID 冲突与重复的草稿，按编号排序
     × compareArtifactIds 按数字编号排序
   ❯ partition / coverage / loadCoveredClauses (3)
     × 按确认状态拆分条款与用例
     × 统计覆盖率
     × 跨模块加载被覆盖条款

失败原因：DispositionSchema、resolveReviewer、moduleOfId 等均未导出
```

### GREEN：全部通过
```
$ pnpm vitest run packages/core/test/plan3-core.test.ts
RUN  v5.1.0 E:/crosscheck/.claude/worktrees/plan3-cli-tui

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  10:47:35
   Duration  412ms

✓ packages/core/test/plan3-core.test.ts > 处置记录 > clause_issue 必须带 clauseId...
✓ packages/core/test/plan3-core.test.ts > 处置记录 > 同一用例与预期后写覆盖先写
✓ packages/core/test/plan3-core.test.ts > resolveReviewer > 优先使用 CROSSCHECK_REVIEWER
✓ packages/core/test/plan3-core.test.ts > resolveReviewer > 否则使用系统用户名
✓ packages/core/test/plan3-core.test.ts > resolveReviewer > 都拿不到时报错
✓ packages/core/test/plan3-core.test.ts > moduleOfId > 从条款与用例 ID 推断模块
✓ packages/core/test/plan3-core.test.ts > readProfileFile > 区分缺失、不合法、合法...
✓ packages/core/test/plan3-core.test.ts > mergeDrafts > 保留已确认条目...
✓ packages/core/test/plan3-core.test.ts > mergeDrafts > compareArtifactIds...
✓ packages/core/test/plan3-core.test.ts > partition/coverage/loadCoveredClauses > 按确认状态...
✓ packages/core/test/plan3-core.test.ts > partition/coverage/loadCoveredClauses > 统计覆盖率
✓ packages/core/test/plan3-core.test.ts > partition/coverage/loadCoveredClauses > 跨模块加载...

$ pnpm vitest run packages/core
Test Files  16 passed (16)
      Tests  236 passed (236)

$ pnpm typecheck
> tsc -p tsconfig.json --noEmit
(无输出，表示成功)
```

## 文件变更

- **新建**：
  - `packages/core/src/schema/disposition.ts`（36 行）
  - `packages/core/src/approvals/reviewer.ts`（14 行）
  - `packages/core/src/profile/profile-files.ts`（32 行）
  - `packages/core/src/workflow/drafts.ts`（64 行）
  - `packages/core/test/plan3-core.test.ts`（104 行）

- **修改**：
  - `packages/core/src/schema/artifacts.ts`（追加 moduleOfId，7 行）
  - `packages/core/src/index.ts`（增加 4 条导出）

总新增代码：261 行

## 自审查

### 完整性检查
✓ 所有 12 个测试都通过
✓ 所有 DECISIONS 类型已实现
✓ 所有接口均符合简要中的签名
✓ 所有导出均在 index.ts 中
✓ 错误处理完整（moduleOfId、resolveReviewer）

### 命名与约定
✓ 标识符使用英文（module、disposition、reviewer、draft）
✓ 注释和错误消息使用中文
✓ 导出名称与简要一致

### 行为验证
✓ DispositionSchema 的 superRefine 正确实现了 clause_issue 与 clauseId 的互斥性
✓ upsertDisposition 不修改入参（使用展开运算符）
✓ resolveReviewer 正确处理空白字符串（使用 trim()）
✓ moduleOfId 的正则匹配 AC/TC 两种类型
✓ readProfileFile 返回的状态类型正确对应三种情况
✓ mergeDrafts 按编号排序（numeric sort，不是字典序）
✓ coverage 正确计算被覆盖和未覆盖的集合
✓ loadCoveredClauses 跨模块加载时去重

### 测试质量
✓ 处置记录测试验证了约束条件和修改行为
✓ resolveReviewer 测试覆盖了三条优先级路径
✓ moduleOfId 测试验证了多种格式和错误情况
✓ readProfileFile 测试验证了三种状态和带默认值的解析
✓ mergeDrafts 测试验证了 ID 冲突、内容重复、排序
✓ partition 测试验证了确认状态分组
✓ coverage 测试验证了交集和差集计算
✓ loadCoveredClauses 测试验证了跨模块加载和去重

### 没有发现的问题
- 初次实现的 `at` 字段曾偏离简要，现已按下方修复记录改为 `z.iso.datetime()`
- 没有超出范围的功能
- 所有依赖都已在项目中存在
- 类型检查通过，无编译问题

## 提交信息

```
feat(core): 处置记录、确认人、画像逐文件读取与草稿合并

实现 core 通用能力：
- 处置记录（DispositionSchema、upsertDisposition）
- 确认人解析（resolveReviewer）
- 模块推断（moduleOfId）
- 画像逐文件读取（readProfileFile、readProfileFiles）
- 草稿合并（mergeDrafts、compareArtifactIds、clauseDuplicateKey）
- 分区和覆盖率统计（partitionClauses、partitionCases、coverage、loadCoveredClauses）

所有测试通过，类型检查正常。
Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

## 关键决策

1. **disposition.ts 中的 at 字段类型（已更正）**：按计划使用 `z.iso.datetime()`。此前关于该 API 在当前 zod 版本中可能不存在或不稳定、计划写法有误的断言没有依据，现予以撤回。同包 `packages/core/src/schema/evidence.ts` 和 `packages/core/src/schema/run.ts` 已使用 `z.iso.datetime()`，本次修复后的回归测试与类型检查也均通过。

2. **错误处理一致性**：所有可能失败的操作（moduleOfId、resolveReviewer、readProfileFile）都选择抛出异常而非返回 Maybe 类型，与项目中其他类似操作保持一致。

3. **排序实现**：mergeDrafts 中的排序使用了 compareArtifactIds，该函数根据 ID 末尾的数字编号进行数值排序（而非字符串排序），确保 M-AC-2 排在 M-AC-10 之前。

## 审查修复报告（2026-11-16）

- 修复范围：`packages/core/src/schema/disposition.ts` 仅将 `at` 从 `z.string().datetime()` 改为 `z.iso.datetime()`，与计划及同包既有用法保持一致；未改动其他代码。
- 报告更正：撤回上述关于 `z.iso.datetime()` 可能不可用或不稳定的错误断言，并更正“所有代码逐字转录”的不准确表述。
- 执行目录：`E:\crosscheck\.claude\worktrees\plan3-cli-tui`。
- 初始工作区干净，当前分支为 `worktree-plan3-cli-tui`。
- 本报告被 `.superpowers/sdd/.gitignore` 的 `*` 规则忽略，按本次明确要求单独强制加入提交，不修改忽略规则。

### 实际验证命令与输出

```text
$ pnpm vitest run packages/core/test/plan3-core.test.ts

 RUN  v5.1.0 E:/crosscheck/.claude/worktrees/plan3-cli-tui


 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  11:05:13
   Duration  440ms (import 53%, tests 24%, transform 21%, worker 2%)
```

退出码：`0`。

```text
$ pnpm typecheck

> crosscheck-monorepo@ typecheck E:\crosscheck\.claude\worktrees\plan3-cli-tui
> tsc -p tsconfig.json --noEmit
```

退出码：`0`。
