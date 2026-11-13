# Crosscheck

通用的 AI 自动化验收测试 CLI：判定标准来自经人确认的需求条款，判定必须引用工具层自动采集的证据，执行与复核由不同模型独立完成。

- 设计说明：`docs/specs/2026-11-12-v1-design.md`
- 实施计划：`docs/superpowers/plans/`

## 开发

需要 Node.js ≥ 22.12（开发与测试）与 pnpm 9。

    pnpm install
    pnpm test        # 单元测试（使用假模型，不消耗 token）
    pnpm typecheck

## 包

| 包 | 职责 |
|---|---|
| `@crosscheck/core` | 工件 schema 与存储、确认机制、工作流门禁、守卫、合议、脱敏、预算 |
| `@crosscheck/models` | 按角色解析模型、重试与备用模型、用量统计 |
| `@crosscheck/agent` | 代理循环、工具授权、假模型 |
| `@crosscheck/discovery` | 只读提取本地项目与 OpenAPI 事实候选 |
| `@crosscheck/requirements` | 从调用方提供的文档中提取可追溯的需求条款草稿 |

## 项目发现

```ts
import { discover, openApiPlugin, staticScanPlugin } from '@crosscheck/discovery';

const result = await discover({
  projectRoot: '/path/to/project',
  plugins: [staticScanPlugin, openApiPlugin(['openapi.yaml'])],
});
console.log(result.facts, result.diagnostics);
```

发现只读取项目内允许的本地文件，不执行发现的命令，也不访问网络。输出是待审核的事实候选，不是网络访问授权；文档中的服务器地址不会加入授权列表。插件是受信任的进程内代码，只读接口不是恶意插件的安全沙箱。脱敏采用有限的启发式规则，不能保证清除所有隐私或秘密；来源摘录、文件名和结果仍应谨慎处理。

OpenAPI 支持 3.0、3.1 和 Swagger 2 的本地 JSON/YAML 接口目录，包含参数覆盖、文档内 JSON Pointer、服务器和来源行号；外部引用不读取或请求，无法完整解析的操作会诊断并跳过。不做完整规范校验、认证或 requestBody 建模。含明确用户信息的路径会诊断跳过，普通路径内部的双斜杠保持原样。带引号的内联凭证会保守遮盖到行尾，命令候选不保证仍可执行。Compose 长语法仅接受有效静态 target 和可选 published 端口；变量及无法绑定实际 ports 项来源的结构会诊断跳过。静态扫描的 POM 只支持受限 XML 子集，不展开实体、DTD 或外部内容。

## 需求条款提取

调用方负责选择和配置模型，并显式提供文档文本；`file` 仅是来源标识，服务不会读取该文件。

```ts
import { BudgetTracker } from '@crosscheck/core';
import { extractRequirements } from '@crosscheck/requirements';

// model 由宿主提供，符合已有 ModelCandidate 的模型接口。
const result = await extractRequirements({
  module: 'M01',
  documents: [{ file: 'req.md', text: '用户必须登录' }],
  models: [{ ref: 'provider:model', model }],
  budget: new BudgetTracker({ steps: 10, tokens: 10000, minutes: 1 }),
});

if (result.status === 'done') {
  const drafts = result.output; // 仅为草稿，交由人工审核
} else {
  console.log(result.reason, result.detail);
}
```

服务不提供文件、源码或网络工具，也不会保存或确认条款。来源文件、行号与摘录的匹配校验不能证明条款语义正确，草稿仍需人工审核。返回的 `messages` 可能包含需求内容，不应自动写盘或视为公开日志。文档长度限制不是模型上下文预算；实际 token 预算由 `BudgetTracker` 和模型用量回执控制。
