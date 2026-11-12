import type { BudgetTracker } from '@crosscheck/core';
import { callWithFallback, type ModelCandidate, type ResilienceOptions } from '@crosscheck/models';
import { generateText, jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { grantTools, type Stage } from './grants';
import type { AgentTool } from './tool';

export const FINISH_TOOL = 'finish';
export const REPORT_BLOCKED_TOOL = 'report_blocked';
const ReportBlockedInput = z.object({ reason: z.string().min(1) });

export type BlockReason = 'budget' | 'invalid-output' | 'reported' | 'interrupted' | 'model-error';

export interface ToolCallEvent {
  name: string;
  input: unknown;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface RunAgentOptions<O> {
  stage: Stage;
  /** 主模型在前，备用模型在后 */
  models: ModelCandidate[];
  system: string;
  messages: ModelMessage[];
  tools: AgentTool[];
  /** 最终结果的结构，代理通过 finish 工具提交 */
  output: z.ZodType<O>;
  budget: BudgetTracker;
  signal?: AbortSignal;
  /** 累计多少次不合格输出后判为 BLOCKED，默认 3 */
  maxInvalidOutputs?: number;
  resilience?: ResilienceOptions;
  onUsage?: (ref: string, usage: { inputTokens?: number; outputTokens?: number }) => void;
  /** 每次工具调用的回调，计划 2 用它记录轨迹 */
  onToolCall?: (e: ToolCallEvent) => void;
}

interface RunInfo {
  steps: number;
  retried: boolean;
  messages: ModelMessage[];
}

export type AgentResult<O> =
  | ({ status: 'done'; output: O } & RunInfo)
  | ({ status: 'blocked'; reason: BlockReason; detail: string } & RunInfo);

type ToolResultOutput = { type: 'json'; value: any } | { type: 'error-text'; value: string };

function toJsonValue(v: unknown): unknown {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

function schemaOf(s: z.ZodType) {
  // 只把 JSON Schema 交给 SDK，不让 SDK 校验；校验由我们用 zod 完成，便于把错误反馈给模型
  return jsonSchema(z.toJSONSchema(s, { io: 'input' }) as Parameters<typeof jsonSchema>[0]);
}

function buildSdkTools(granted: AgentTool[], output: z.ZodType): ToolSet {
  const set: ToolSet = {};
  for (const t of granted) set[t.name] = tool({ description: t.description, inputSchema: schemaOf(t.input) });
  set[FINISH_TOOL] = tool({ description: '提交最终结果。参数必须完全符合给定结构。', inputSchema: schemaOf(output) });
  set[REPORT_BLOCKED_TOOL] = tool({
    description: '遇到无法自行解决的障碍时调用并说明原因。不要尝试绕过障碍。',
    inputSchema: schemaOf(ReportBlockedInput),
  });
  return set;
}

/**
 * 自研代理循环：每轮调用一次模型，由我们执行工具并校验输入输出。
 * 硬约束：只暴露本阶段授予的工具；必须通过 finish 提交合法结果；预算耗尽或中断即停止。
 */
export async function runAgent<O>(opts: RunAgentOptions<O>): Promise<AgentResult<O>> {
  const { stage, models, system, output, budget, signal, maxInvalidOutputs = 3, resilience, onUsage, onToolCall } = opts;

  for (const t of opts.tools) {
    if (t.name === FINISH_TOOL || t.name === REPORT_BLOCKED_TOOL) throw new Error(`工具名与内置工具冲突：${t.name}`);
  }
  const { granted } = grantTools(stage, opts.tools);
  const toolMap = new Map(granted.map((t) => [t.name, t]));
  const sdkTools = buildSdkTools(granted, output);
  const messages: ModelMessage[] = [...opts.messages];
  const abortSignal = signal ?? new AbortController().signal;

  let steps = 0;
  let retried = false;
  let invalid = 0;
  const info = (): RunInfo => ({ steps, retried, messages });
  const blocked = (reason: BlockReason, detail: string): AgentResult<O> => ({ status: 'blocked', reason, detail, ...info() });

  while (true) {
    if (abortSignal.aborted) return blocked('interrupted', '执行被中断');
    const exhausted = budget.exhausted();
    if (exhausted) return blocked('budget', exhausted);

    let res: Awaited<ReturnType<typeof generateText>>;
    let ref: string;
    try {
      const r = await callWithFallback(
        models,
        (model) => generateText({ model, system, messages, tools: sdkTools, maxRetries: 0, abortSignal }),
        resilience,
      );
      res = r.value;
      ref = r.ref;
      if (r.attempts > 1) retried = true;
    } catch (err) {
      if (abortSignal.aborted) return blocked('interrupted', '执行被中断');
      return blocked('model-error', err instanceof Error ? err.message : String(err));
    }

    steps++;
    budget.recordStep();
    budget.recordTokens((res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0));
    onUsage?.(ref, { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens });
    messages.push(...res.responseMessages);

    if (res.toolCalls.length === 0) {
      invalid++;
      if (invalid >= maxInvalidOutputs) return blocked('invalid-output', `连续 ${invalid} 次没有按要求调用工具`);
      messages.push({
        role: 'user',
        content: `你必须调用工具：完成时调用 ${FINISH_TOOL} 提交结果，无法继续时调用 ${REPORT_BLOCKED_TOOL}。`,
      });
      continue;
    }

    const results: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; output: ToolResultOutput }> = [];
    let finished: { value: O } | undefined;
    let reported: string | undefined;

    for (const call of res.toolCalls) {
      const reply = (out: ToolResultOutput) =>
        results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: out });

      if (call.toolName === FINISH_TOOL) {
        const parsed = output.safeParse(call.input);
        if (parsed.success) {
          finished = { value: parsed.data };
          reply({ type: 'json', value: '已收到' });
        } else {
          invalid++;
          reply({ type: 'error-text', value: `结果不合格，请修正后重新调用 ${FINISH_TOOL}：\n${z.prettifyError(parsed.error)}` });
        }
        continue;
      }

      if (call.toolName === REPORT_BLOCKED_TOOL) {
        const parsed = ReportBlockedInput.safeParse(call.input);
        reported = parsed.success ? parsed.data.reason : '代理上报障碍但未说明原因';
        reply({ type: 'json', value: '已记录' });
        continue;
      }

      const t = toolMap.get(call.toolName);
      if (!t) {
        const error = `工具 ${call.toolName} 在 ${stage} 阶段未授予`;
        onToolCall?.({ name: call.toolName, input: call.input, ok: false, error });
        reply({ type: 'error-text', value: error });
        continue;
      }
      const parsed = t.input.safeParse(call.input);
      if (!parsed.success) {
        const error = `工具 ${t.name} 的输入不合法：\n${z.prettifyError(parsed.error)}`;
        onToolCall?.({ name: t.name, input: call.input, ok: false, error });
        reply({ type: 'error-text', value: error });
        continue;
      }
      try {
        const out = toJsonValue(await t.execute(parsed.data, { signal: abortSignal }));
        onToolCall?.({ name: t.name, input: parsed.data, ok: true, output: out });
        reply({ type: 'json', value: out });
      } catch (err) {
        const error = `工具 ${t.name} 执行失败：${err instanceof Error ? err.message : String(err)}`;
        onToolCall?.({ name: t.name, input: parsed.data, ok: false, error });
        reply({ type: 'error-text', value: error });
      }
    }

    messages.push({ role: 'tool', content: results });

    if (reported !== undefined) return blocked('reported', reported);
    if (finished) return { status: 'done', output: finished.value, ...info() };
    if (invalid >= maxInvalidOutputs) return blocked('invalid-output', `结果连续 ${invalid} 次不合格`);
  }
}
