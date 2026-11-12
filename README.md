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
