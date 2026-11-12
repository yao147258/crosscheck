import type { z } from 'zod';

export type ToolCategory = 'browser' | 'http' | 'db' | 'fixture' | 'profile' | 'requirements';

export interface ToolContext {
  signal: AbortSignal;
}

export interface AgentTool<I = any> {
  /** 只允许字母、数字、下划线、连字符（部分厂商不接受点号） */
  name: string;
  category: ToolCategory;
  description: string;
  input: z.ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<unknown>;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function defineTool<I>(t: AgentTool<I>): AgentTool<I> {
  if (!TOOL_NAME.test(t.name)) throw new Error(`工具名只能包含字母、数字、下划线和连字符：${t.name}`);
  return t;
}
