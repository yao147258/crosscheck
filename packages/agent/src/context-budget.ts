import { DEFAULT_CONTEXT_WINDOW } from '@crosscheck/models';
import type { ContextPolicy } from './context';

const OUTPUT_RESERVE_RATIO = 0.15;
const MAX_OUTPUT_RESERVE = 32_000;
const SAFETY_MARGIN = 1_024;
const ATTACHMENT_RATIO = 0.4;
const TOOL_RESULT_RATIO = 0.03;

export interface ContextBudget {
  window: number;
  /** 输出预留，仅用于输入预算，不限制 maxOutputTokens */
  reserve: number;
  /** system 与工具 schema 的估算 */
  fixed: number;
  /** 可用输入 token，不为负 */
  input: number;
  /** 证据附件可用 token */
  attachments: number;
}

export type ResolvedPolicy = Required<ContextPolicy>;

export function deriveBudget(window: number = DEFAULT_CONTEXT_WINDOW, fixedTokens: number): ContextBudget {
  const reserve = Math.min(Math.round(window * OUTPUT_RESERVE_RATIO), MAX_OUTPUT_RESERVE);
  const input = Math.max(0, window - reserve - fixedTokens - SAFETY_MARGIN);
  return { window, reserve, fixed: fixedTokens, input, attachments: Math.floor(input * ATTACHMENT_RATIO) };
}

/** token 按 1:1 换算字符（非 ASCII 每字符计 1 token），宁少勿多；现有默认值作为下限，避免大窗口反而更严。 */
export function derivePolicy(budget: ContextBudget, explicit: ContextPolicy = {}): ResolvedPolicy {
  const perTool = Math.max(8_000, Math.floor(budget.input * TOOL_RESULT_RATIO));
  return {
    maxToolChars: explicit.maxToolChars ?? perTool,
    maxEvidenceChars: explicit.maxEvidenceChars ?? perTool,
    retainRecentToolRounds: explicit.retainRecentToolRounds ?? 1,
    maxAttachmentChars: explicit.maxAttachmentChars ?? Math.max(64_000, budget.attachments),
    maxAttachmentBytes: explicit.maxAttachmentBytes ?? 8 * 1024 * 1024,
  };
}

/** 以真实 usage 校准估算系数：只升不降，避免多次估少后被 provider 拒绝。 */
export function calibrate(previous: number, estimated: number, actual: number | undefined): number {
  if (!actual || actual <= 0 || estimated <= 0) return previous;
  return Math.max(previous, actual / estimated);
}
