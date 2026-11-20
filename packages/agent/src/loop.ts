import type { BudgetTracker } from '@crosscheck/core';
import { callWithFallback, outputTokenLimitForEstimate, type ModelCandidate, type ResilienceOptions } from '@crosscheck/models';
import { generateText, jsonSchema, tool, type LanguageModelUsage, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { applyCacheBreakpoints } from './cache';
import { grantTools, type Stage } from './grants';
import { defineTool, type AgentTool } from './tool';
import { type ContextPolicy, type EvidencePresenter, type EvidencePresentedEvent } from './context';
import { ContextManager, type ContextReport, type PreparedContext } from './context-manager';
import { createModelSummarizer } from './summarizer';

export const FINISH_TOOL = 'finish';
export const REPORT_BLOCKED_TOOL = 'report_blocked';
const ReportBlockedInput = z.object({ reason: z.string().min(1) });

export type BlockReason = 'budget' | 'invalid-output' | 'reported' | 'interrupted' | 'model-error';
export type OutputValidation = { ok: true } | { ok: false; error: string };

export interface ToolCallEvent {
  name: string;
  input: unknown;
  ok: boolean;
  output?: unknown;
  error?: string;
  agentId?: string;
  parentId?: string;
}

export type ContextPreparedEvent = ContextReport & { agentId?: string; parentId?: string };

export interface RunAgentOptions<O> {
  stage: Stage;
  /** 主模型在前，备用模型在后 */
  models: ModelCandidate[];
  system: string;
  messages: ModelMessage[];
  tools: AgentTool[];
  /** 本地运行时校验，支持异步 refinement；不会代替宿主语义校验。 */
  output: z.ZodType<O>;
  /** 可表示的基础结构，仅用于生成 SDK JSON Schema；省略时使用 output。 */
  outputSchema?: z.ZodType;
  /** 本地语义校验，与运行时结构校验共用累计 invalid 额度；异常直接传播。 */
  validateOutput?: (value: O) => OutputValidation | Promise<OutputValidation>;
  budget: BudgetTracker;
  signal?: AbortSignal;
  evidencePresenter?: EvidencePresenter;
  /** 每个真实候选请求装配后 await，列表仅含最终附件；宿主必须替换而非累计 shown。异常不做 provider 重试。 */
  onEvidencePresented?: (event: EvidencePresentedEvent) => void | Promise<void>;
  contextPolicy?: ContextPolicy;
  /** 由宿主决定判定必需证据；默认所有已知证据都必须完整呈现。 */
  requiredEvidenceIds?: readonly string[];
  /** 可提前停止，但不能将累计额度放宽到三次以上。 */
  maxInvalidOutputs?: number;
  resilience?: ResilienceOptions;
  onUsage?: (ref: string, usage: AttemptUsage) => void | Promise<void>;
  /** 每次真实 provider 调用终结后立即 await；宿主异常原样传播，不触发 provider 重试。 */
  onModelAttempt?: (attempt: ModelAttempt) => void | Promise<void>;
  /** 内存审计通知，未经清洗不能直接持久化为轨迹；异常传播，不允许继续 PASS。 */
  onToolCall?: (e: ToolCallEvent) => void | Promise<void>;
  /** 省略时按 stage 构造；摘要权限由阶段决定 */
  contextManager?: ContextManager;
  /** 每个真实候选装配后 await；异常按宿主故障传播。 */
  onContextPrepared?: (event: ContextPreparedEvent) => void | Promise<void>;
  /** 宿主提供时所有事件附带；子代理由 spawnSubAgent 设置 */
  agentId?: string;
  parentId?: string;
}

export type AttemptUsage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
/** purpose 仅在压缩摘要调用时出现；agentId/parentId 仅在宿主提供 agentId 或子代理中出现。 */
export type ModelAttempt = ({ ref: string; status: 'error'; usage: null } | { ref: string; status: 'success'; usage: AttemptUsage })
  & { purpose?: 'compact'; agentId?: string; parentId?: string };

interface RunInfo {
  steps: number;
  /** 实际模型调用次数，独立于外层代理轮次；失败无 usage 时不推测 token。 */
  attempts: number;
  modelAttempts: ModelAttempt[];
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
  // SDK 只接收可表示的 JSON Schema，所有运行时校验由宿主执行。
  return jsonSchema(z.toJSONSchema(s, { io: 'input' }) as Parameters<typeof jsonSchema>[0]);
}

function buildSdkTools(granted: AgentTool[], output: z.ZodType): ToolSet {
  const set: ToolSet = Object.create(null);
  for (const t of granted) set[t.name] = tool({ description: t.description, inputSchema: schemaOf(t.input) });
  set[FINISH_TOOL] = tool({ description: '提交最终结果。参数必须完全符合给定结构。', inputSchema: schemaOf(output) });
  set[REPORT_BLOCKED_TOOL] = tool({
    description: '遇到无法自行解决的障碍时调用并说明原因。不要尝试绕过障碍。',
    inputSchema: schemaOf(ReportBlockedInput),
  });
  return set;
}

/** 自研代理循环：一轮一次生成；统一补齐调用结果，再检查终结条件。 */
export async function runAgent<O>(opts: RunAgentOptions<O>): Promise<AgentResult<O>> {
  const { stage, models, system, output, budget, signal, resilience, onUsage } = opts;
  const maxInvalidOutputs = Math.min(opts.maxInvalidOutputs ?? 3, 3);
  if (!Number.isInteger(maxInvalidOutputs) || maxInvalidOutputs < 1) throw new Error('invalid 额度必须为 1 到 3');
  const names = new Set<string>();
  // 对全部工具预检，包括本阶段不授予的工具，拒绝发生在模型调用等副作用之前。
  for (const t of opts.tools) {
    defineTool(t);
    if (t.name === FINISH_TOOL || t.name === REPORT_BLOCKED_TOOL) throw new Error(`工具名与内置工具冲突：${t.name}`);
    if (names.has(t.name)) throw new Error(`工具名重复：${t.name}`);
    names.add(t.name);
  }
  const { granted } = grantTools(stage, opts.tools);
  const toolMap = new Map(granted.map((t) => [t.name, t]));
  const sdkTools = buildSdkTools(granted, opts.outputSchema ?? output);
  // 工具定义同样占用上下文窗口，参与输出上限的输入估算。
  const toolSchemas = [...granted.map((t) => z.toJSONSchema(t.input, { io: 'input' })), z.toJSONSchema(opts.outputSchema ?? output, { io: 'input' })];
  const messages: ModelMessage[] = [...opts.messages];
  const abortSignal = signal ?? new AbortController().signal;
  let steps = 0;
  let attempts = 0;
  let retried = false;
  let invalid = 0;
  let lastInvalidTruncated = false;
  const modelAttempts: ModelAttempt[] = [];
  const tag = opts.agentId ? { agentId: opts.agentId, ...(opts.parentId ? { parentId: opts.parentId } : {}) } : {};
  const onToolCall = opts.onToolCall && ((e: ToolCallEvent) => opts.onToolCall!({ ...e, ...tag }));
  const usageOf = (u: LanguageModelUsage): AttemptUsage => ({
    inputTokens: u.inputTokens, outputTokens: u.outputTokens,
    ...(u.inputTokenDetails?.cacheReadTokens !== undefined ? { cacheReadTokens: u.inputTokenDetails.cacheReadTokens } : {}),
    ...(u.inputTokenDetails?.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.inputTokenDetails.cacheWriteTokens } : {}),
  });
  // 宿主故障状态需被摘要审计（发生在 manager.prepare 内）共享，故提升到循环外，每轮开始时重置。
  let hostError: unknown;
  let hostFailed = false;
  const record = async (attempt: ModelAttempt) => {
    const tagged = { ...attempt, ...tag } as ModelAttempt;
    modelAttempts.push(tagged);
    try { await opts.onModelAttempt?.(tagged); }
    catch (error) {
      hostError = error; hostFailed = true;
      throw Object.assign(new Error('宿主模型审计失败'), { name: 'AbortError' });
    }
  };
  const manager = opts.contextManager ?? new ContextManager({
    stage, policy: opts.contextPolicy, presenter: opts.evidencePresenter, requiredEvidenceIds: opts.requiredEvidenceIds,
    // 摘要调用也是真实模型调用：计入预算、attempts 与审计。
    summarize: createModelSummarizer({ budget, onAttempt: async attempt => { attempts++; await record(attempt); } }),
  });
  const info = (): RunInfo => ({ steps, attempts, modelAttempts, retried, messages });
  const blocked = (reason: BlockReason, detail: string): AgentResult<O> => ({ status: 'blocked', reason, detail, ...info() });
  const boundedSignal = () => AbortSignal.any([abortSignal, AbortSignal.timeout(budget.remainingMs())]);
  const stop = (bounded?: AbortSignal): { reason: 'interrupted' | 'budget'; detail: string } | undefined => {
    if (abortSignal.aborted) return { reason: 'interrupted', detail: '执行被中断' };
    const overrun = budget.overrun();
    if (overrun || bounded?.aborted || budget.remainingMs() === 0) return { reason: 'budget', detail: overrun ?? '时长预算耗尽' };
  };

  while (true) {
    const stopped = stop();
    if (stopped) return blocked(stopped.reason, stopped.detail);
    const exhausted = budget.exhausted();
    if (exhausted) return blocked('budget', exhausted);

    let res: Awaited<ReturnType<typeof generateText>>;
    let ref: string;
    const genSignal = boundedSignal();
    let roundAttempts = 0;
    let incompleteEvidenceIds: readonly string[] = [];
    // 原为每轮新建的局部状态，提升后按轮重置以保持语义。
    hostError = undefined;
    hostFailed = false;
    try {
      const r = await callWithFallback(
        models,
        async (model, ref, candidate) => {
          // 宿主读取失败不是厂商错误，不得重试/备用后吞掉继续 PASS。
          if (hostFailed) throw hostError;
          const stopped = stop(genSignal);
          if (stopped) throw Object.assign(new Error(stopped.detail), { name: 'AbortError' });
          let prepared: PreparedContext;
          try {
            prepared = await manager.prepare(messages, { candidate, system, toolSchemas, signal: genSignal });
            await opts.onEvidencePresented?.({ ref, evidence: prepared.presentedEvidence });
            await opts.onContextPrepared?.({ ...prepared.report, ...tag });
          } catch (error) {
            // 摘要审计回调失败时已登记宿主故障，保留其原错误。
            if (hostFailed) throw error;
            // 只识别明确取消来源；同时abort的真实磁盘/verify错误仍为宿主原错。
            if (genSignal.aborted && (error === genSignal.reason || error instanceof Error && error.name === 'AbortError')) throw error;
            hostError = error; hostFailed = true;
            throw Object.assign(new Error('宿主证据装配失败'), { name: 'AbortError' });
          }
          incompleteEvidenceIds = prepared.incompleteEvidenceIds;
          const afterPresentation = stop(genSignal);
          if (afterPresentation) throw Object.assign(new Error(afterPresentation.detail), { name: 'AbortError' });
          // 输入超出窗口时抛出不可重试错误，不计为真实模型调用。
          const maxOutputTokens = outputTokenLimitForEstimate(candidate.contextWindow, prepared.estimatedInputTokens);
          attempts++;
          roundAttempts++;
          if (roundAttempts > 1) retried = true;
          const request = applyCacheBreakpoints(system, prepared.messages, prepared.historyLength, candidate.providerType);
          let value: Awaited<ReturnType<typeof generateText>>;
          try {
            value = await generateText({ model, system: request.system, messages: request.messages, tools: sdkTools, maxOutputTokens, maxRetries: 0, abortSignal: genSignal });
          } catch (error) {
            await record({ ref, status: 'error', usage: null });
            throw error;
          }
          manager.observe(ref, prepared.estimatedInputTokens, value.usage.inputTokens);
          // 回调位于 provider catch 之外，不能把宿主失败计成额外模型调用。
          await record({ ref, status: 'success', usage: usageOf(value.usage) });
          return value;
        },
        { ...resilience, signal: genSignal },
      );
      res = r.value;
      ref = r.ref;
    } catch (err) {
      // 已确认的宿主故障优先于同时发生的取消/预算，保留原错误对象。
      if (hostFailed) throw hostError;
      const stopped = stop(genSignal);
      if (stopped) return blocked(stopped.reason, stopped.detail);
      return blocked('model-error', err instanceof Error ? err.message : String(err));
    }

    steps++;
    budget.recordStep();
    budget.recordTokens((res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0));
    // 不接收 SDK 自动错误结果，保证每个调用恰有一条本地结果。
    messages.push(...res.responseMessages.filter((m) => m.role !== 'tool'));
    const calls = res.toolCalls;
    // 达到 maxOutputTokens 时调用参数可能不完整，即使恰好通过校验也不能采信。
    const truncated = res.finishReason === 'length';
    const results: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; output: ToolResultOutput }> = [];
    let finished: { value: O } | undefined;
    let reported: string | undefined;
    let terminal = stop(genSignal);
    let invalidRound = false;
    const hasReportBlocked = calls.some((c) => c.toolName === REPORT_BLOCKED_TOOL);
    const finishMustBeAlone = !hasReportBlocked && calls.some((c) => c.toolName === FINISH_TOOL) && calls.length > 1;

    try {
      await onUsage?.(ref, usageOf(res.usage));
      terminal ??= stop(genSignal);
      for (const call of calls) {
        const reply = (out: ToolResultOutput) => results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: out });
        const fail = async (error: string) => {
          reply({ type: 'error-text', value: error });
          await onToolCall?.({ name: call.toolName, input: call.input, ok: false, error });
        };
        terminal ??= stop();
        if (terminal) { await fail(`未执行：${terminal.detail}`); continue; }
        if (hasReportBlocked && call.toolName !== REPORT_BLOCKED_TOOL) { await fail('未执行：本轮已上报障碍'); continue; }
        if (finishMustBeAlone) {
          invalidRound = true;
          await fail('finish 必须单独调用：请观察工具结果后再提交。');
          continue;
        }
        if (call.invalid && (toolMap.has(call.toolName) || call.toolName === FINISH_TOOL || call.toolName === REPORT_BLOCKED_TOOL)) {
          invalidRound = true;
          await fail('工具输入不合法：无法解析 JSON，请提交有效 JSON 参数。');
          continue;
        }
        if (call.toolName === FINISH_TOOL) {
          const parsed = await output.safeParseAsync(call.input);
          const validation = incompleteEvidenceIds.length ? { ok: false as const, error: `必需证据未完整呈现（truncated 或缺失）：${incompleteEvidenceIds.join(',')}` }
            : truncated ? { ok: false as const, error: '输出达到 token 上限被截断，结果可能不完整' }
            : parsed.success ? await opts.validateOutput?.(parsed.data) : undefined;
          if (parsed.success && (!validation || validation.ok)) {
            finished = { value: parsed.data };
            reply({ type: 'json', value: '已收到' });
            await onToolCall?.({ name: FINISH_TOOL, input: call.input, ok: true, output: parsed.data });
          } else {
            invalidRound = true;
            const error = parsed.success ? (validation as { ok: false; error: string }).error : z.prettifyError(parsed.error);
            await fail(`结果不合格，请修正后重新调用 ${FINISH_TOOL}：\n${error}`);
          }
          terminal ??= stop();
          continue;
        }
        if (call.toolName === REPORT_BLOCKED_TOOL) {
          const parsed = ReportBlockedInput.safeParse(call.input);
          reported ??= parsed.success ? parsed.data.reason : '代理上报障碍但未说明原因';
          reply({ type: 'json', value: '已记录' });
          await onToolCall?.({ name: REPORT_BLOCKED_TOOL, input: call.input, ok: true, output: reported });
          continue;
        }
        const t = toolMap.get(call.toolName);
        if (!t) { await fail(`工具 ${call.toolName} 在 ${stage} 阶段未授予`); continue; }
        const parsed = await t.input.safeParseAsync(call.input);
        if (!parsed.success) { await fail(`工具 ${t.name} 的输入不合法：\n${z.prettifyError(parsed.error)}`); continue; }
        terminal ??= stop();
        if (terminal) { await fail(`未执行：${terminal.detail}`); continue; }
        const execSignal = boundedSignal();
        let raw: unknown;
        try {
          raw = await t.execute(parsed.data, { signal: execSignal });
        } catch (err) {
          terminal ??= stop(execSignal);
          await fail(`工具 ${t.name} 执行失败：${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        // 真实工具完成后立即检查，不启动后续工具；不能通过只竞速 Promise 声称工具已停止。
        terminal ??= stop(execSignal);
        let out: unknown;
        try { out = toJsonValue(raw); }
        catch (err) {
          const error = `工具 ${t.name} 已执行，但结果无法序列化：${err instanceof Error ? err.message : String(err)}`;
          reply({ type: 'error-text', value: error });
          await onToolCall?.({ name: t.name, input: parsed.data, ok: true, error });
          continue;
        }
        reply({ type: 'json', value: out });
        // 回调不放进序列化或 execute 的 catch，宿主异常不可伪装成普通工具错误后继续 PASS。
        await onToolCall?.({ name: t.name, input: parsed.data, ok: true, output: out });
      }
    } finally {
      // 即使中断、预算或宿主回调抛错，也为已经追加的整轮 assistant 调用补齐结果。
      for (const call of calls.slice(results.length)) results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'error-text', value: '未执行：本轮已停止' } });
      if (results.length) messages.push({ role: 'tool', content: results });
    }
    terminal ??= stop(genSignal);
    if (terminal) return blocked(terminal.reason, terminal.detail);
    if (reported !== undefined) return blocked('reported', reported);
    if (finished) return { status: 'done', output: finished.value, ...info() };
    if (!calls.length) {
      invalidRound = true;
      messages.push({ role: 'user', content: `你必须调用工具：完成时调用 ${FINISH_TOOL} 提交结果，无法继续时调用 ${REPORT_BLOCKED_TOOL}。` });
    }
    if (invalidRound && truncated) messages.push({ role: 'user', content: '上一轮输出达到 token 上限被截断，请精简内容后重新提交。' });
    if (invalidRound) { invalid++; lastInvalidTruncated = truncated; }
    if (invalid >= maxInvalidOutputs) return blocked('invalid-output', `结果累计 ${invalid} 次不合格${lastInvalidTruncated ? '（最近一次输出达到 token 上限被截断）' : ''}`);
  }
}
