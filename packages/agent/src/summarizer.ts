import type { BudgetTracker } from '@crosscheck/core';
import { generateText } from 'ai';
import { z } from 'zod';
import { boundedText } from './context';
import type { Summarizer } from './context-manager';
import type { ModelAttempt } from './loop';

export const SummarySchema = z.object({
  goal: z.string(),
  done: z.array(z.string()),
  findings: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  pending: z.array(z.string()),
});

const SUMMARY_SYSTEM = '你负责压缩代理的较早对话。只依据给定消息输出一个 JSON 对象：{"goal":目标,"done":已完成步骤,"findings":关键发现,"evidenceIds":消息中出现的证据ID,"pending":未完成事项}。不得补充消息中没有的内容，不要输出 JSON 以外的文字。';

export interface SummarizerHooks {
  budget: BudgetTracker;
  /** 每次摘要调用结束后 await；异常原样传播，视为宿主故障。 */
  onAttempt?: (attempt: ModelAttempt) => void | Promise<void>;
}

/** 用当前候选模型生成结构化摘要；失败或不合格返回 undefined，由调用方退回确定性裁剪，不重试。 */
export function createModelSummarizer(hooks: SummarizerHooks): Summarizer {
  return async (older, { candidate, signal, maxChars }) => {
    const body = boundedText(JSON.stringify(older), Math.max(1, maxChars)).text;
    let res: Awaited<ReturnType<typeof generateText>>;
    try {
      res = await generateText({ model: candidate.model, system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: body }], maxOutputTokens: 4_096, maxRetries: 0, abortSignal: signal });
    } catch (error) {
      if (signal.aborted) throw error;
      await hooks.onAttempt?.({ ref: candidate.ref, status: 'error', usage: null, purpose: 'compact' });
      return undefined;
    }
    hooks.budget.recordTokens((res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0));
    await hooks.onAttempt?.({ ref: candidate.ref, status: 'success', usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens }, purpose: 'compact' });
    const text = res.text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return undefined; }
    const result = SummarySchema.safeParse(parsed);
    return result.success ? JSON.stringify(result.data) : undefined;
  };
}
