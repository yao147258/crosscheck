import type { BudgetTracker } from '@crosscheck/core';
import { atGenerateBoundary, createUsageObservationScope, type TokenUsage, type UsageObservationScope, type UsageObserver } from '@crosscheck/models';
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
  usageObserver?: UsageObserver;
  /** 省略时在独立摘要调用结束后排空。 */
  usageObservationScope?: UsageObservationScope;
  /** 每次摘要调用结束后 await；异常原样传播，视为宿主故障。 */
  onAttempt?: (attempt: ModelAttempt) => void | Promise<void>;
}

/** 用当前候选模型生成结构化摘要；失败或不合格返回 undefined，由调用方退回确定性裁剪，不重试。 */
export function createModelSummarizer(hooks: SummarizerHooks): Summarizer {
  return async (older, ctx) => {
    const externalScope = ctx.usageObservationScope ?? hooks.usageObservationScope;
    const scope = externalScope ?? createUsageObservationScope();
    const observer = ctx.usageObserver ?? hooks.usageObserver;
    try { return await summarize(older, ctx, scope, observer); }
    finally { if (!externalScope) await scope.flush(); }
  };

  async function summarize(older: Parameters<Summarizer>[0], { candidate, signal, maxChars }: Parameters<Summarizer>[1], scope: UsageObservationScope, observer: UsageObserver | undefined) {
    const body = boundedText(JSON.stringify(older), Math.max(1, maxChars)).text;
    let res: Awaited<ReturnType<typeof generateText>>;
    signal.throwIfAborted();
    let started = false;
    let receipt: TokenUsage | null = null;
    try {
      const model = atGenerateBoundary(candidate.model, () => { started = true; }, usage => { receipt = usage; });
      res = await generateText({ model, system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: body }], maxOutputTokens: 4_096, maxRetries: 0, abortSignal: signal });
    } catch {
      const cancelled = signal.aborted;
      if (started && observer) scope.enqueue(observer, { ref: candidate.ref, status: cancelled ? 'cancelled' : 'error', usage: receipt, purpose: 'compact' });
      // 中止时 provider 的原始错误未必可识别为取消，统一抛 signal.reason 以命中调用方的取消判定。
      if (cancelled) throw signal.reason;
      await hooks.onAttempt?.({ ref: candidate.ref, status: 'error', usage: null, purpose: 'compact' });
      return undefined;
    }
    if (started && observer) scope.enqueue(observer, { ref: candidate.ref, status: 'success', usage: receipt, purpose: 'compact' });
    hooks.budget.recordTokens((res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0));
    await hooks.onAttempt?.({ ref: candidate.ref, status: 'success', usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens }, purpose: 'compact' });
    const text = res.text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return undefined; }
    const result = SummarySchema.safeParse(parsed);
    return result.success ? JSON.stringify(result.data) : undefined;
  }
}
