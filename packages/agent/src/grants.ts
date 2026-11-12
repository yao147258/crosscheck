import type { AgentTool, ToolCategory } from './tool';

export type Stage = 'extract' | 'plan' | 'prepare' | 'execute' | 'review';

/**
 * 各阶段可授予的工具类别（防作弊硬约束）：
 * - plan 只能读条款和画像，拿不到任何读业务代码或操作系统的工具；
 * - execute 不授予夹具，代理不能自己造数绕过；
 * - review 不授予工具，只基于给定证据判定。
 */
export const STAGE_GRANTS: Record<Stage, readonly ToolCategory[]> = {
  extract: ['profile'],
  plan: ['profile', 'requirements'],
  prepare: ['fixture', 'browser', 'http', 'db', 'profile'],
  execute: ['browser', 'http', 'db', 'profile'],
  review: [],
};

export function grantTools(stage: Stage, tools: AgentTool[]): { granted: AgentTool[]; denied: AgentTool[] } {
  const allowed = new Set(STAGE_GRANTS[stage]);
  const granted: AgentTool[] = [];
  const denied: AgentTool[] = [];
  for (const t of tools) (allowed.has(t.category) ? granted : denied).push(t);
  return { granted, denied };
}
