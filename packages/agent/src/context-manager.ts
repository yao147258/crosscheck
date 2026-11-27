import type { ModelMessage } from 'ai';
import { estimateTokens, type ModelCandidate, type UsageObservationScope, type UsageObserver } from '@crosscheck/models';
import type { Stage } from './grants';
import {
  collectHistoryEvidenceIds, compressContext, demoteAttachments, materializeEvidence, stripToolResults, summaryMessage,
  type ContextPolicy, type EvidencePresentation, type EvidencePresenter,
} from './context';
import { calibrate, deriveBudget, derivePolicy, type ResolvedPolicy } from './context-budget';

/** 允许模型摘要的阶段：判定相关阶段硬性禁止，避免摘要把未见内容写成已见。 */
export const SUMMARY_ALLOWED: Readonly<Record<Stage, boolean>> = { extract: true, plan: true, prepare: false, execute: false, review: false };
/** 超过高水位才压缩、一次压到低水位以下，两次压缩之间只追加以保持缓存前缀稳定。 */
export const HIGH_WATERMARK = 0.85;
export const LOW_WATERMARK = 0.6;

export type ContextLayer = 'L1' | 'L2' | 'L3';

export interface ContextReport {
  ref: string;
  window: number;
  /** 可用输入 token */
  input: number;
  /** 扣除附件后的历史预算 H */
  history: number;
  estimated: { system: number; tools: number; task: number; history: number; attachments: number };
  factor: number;
  layers: ContextLayer[];
  compacted: boolean;
}

interface SummaryUsageOptions {
  usageObserver?: UsageObserver;
  usageObservationScope?: UsageObservationScope;
}

export type Summarizer = (older: ModelMessage[], ctx: SummaryUsageOptions & { candidate: ModelCandidate; signal: AbortSignal; maxChars: number }) => Promise<string | undefined>;

export interface ContextManagerOptions {
  stage: Stage;
  /** 显式值优先于按窗口推导的值 */
  policy?: ContextPolicy;
  presenter?: EvidencePresenter;
  requiredEvidenceIds?: readonly string[];
  summarize?: Summarizer;
}

export interface PrepareInput extends SummaryUsageOptions {
  candidate: ModelCandidate;
  system: string;
  toolSchemas: readonly unknown[];
  signal: AbortSignal;
}

export interface PreparedContext {
  messages: ModelMessage[];
  /** 历史部分条数（附件之前），缓存断点打在其最后一条 */
  historyLength: number;
  estimatedInputTokens: number;
  report: ContextReport;
  evidenceIds: string[];
  incompleteEvidenceIds: string[];
  presentedEvidence: EvidencePresentation[];
}

type Estimate = (inputs: readonly unknown[]) => number;

/** 任务头：首个 assistant 之前的消息（条款、用例等），永不压缩。 */
function headLength(messages: ModelMessage[]): number {
  const i = messages.findIndex(m => m.role === 'assistant');
  return i < 0 ? messages.length : i;
}

/** 最近一轮起点：最后一个 assistant；其后的调用与结果成对保留。 */
function lastRoundStart(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'assistant') return i;
  return messages.length;
}

/** 按候选窗口管理上下文；不依赖 runAgent 内部状态，可被聊天等宿主单独使用。 */
export class ContextManager {
  private readonly factors = new Map<string, number>();
  /** 按窗口保存已定稿前缀：source 为其对应的原始消息条数 */
  private readonly prefixes = new Map<number, { source: number; messages: ModelMessage[] }>();
  private last: ContextReport | undefined;
  /** 公开供 runAgent 校验：注入的管理器阶段必须与运行阶段一致，否则会绕过阶段摘要禁令。 */
  readonly stage: Stage;

  constructor(private readonly options: ContextManagerOptions) {
    this.stage = options.stage;
  }

  get summaryAllowed(): boolean {
    return SUMMARY_ALLOWED[this.options.stage] && !!this.options.summarize;
  }

  report(): ContextReport | undefined {
    return this.last;
  }

  /** 宿主替换整段历史（如清空对话）后调用，丢弃已定稿前缀。 */
  reset(): void {
    this.prefixes.clear();
  }

  observe(ref: string, estimated: number, actual: number | undefined): void {
    this.factors.set(ref, calibrate(this.factor(ref), estimated, actual));
  }

  async prepare(messages: ModelMessage[], input: PrepareInput): Promise<PreparedContext> {
    input.signal.throwIfAborted();
    const { est, budget, policy, system, tools, factor } = this.measure(input);
    const source = demoteAttachments(messages);
    // 证据按 ID 每候选重新物化，放在历史之后，不进入定稿前缀。
    const evidence = await materializeEvidence(collectHistoryEvidenceIds(source), {
      ...policy, ref: input.candidate.ref, signal: input.signal, presenter: this.options.presenter, requiredEvidenceIds: this.options.requiredEvidenceIds,
    });
    const attachments = est([evidence.attachments]);
    const historyBudget = Math.max(0, budget.input - attachments);
    const saved = this.prefixes.get(budget.window);
    const reuse = saved && saved.source <= source.length ? saved : undefined;
    let history = reuse ? [...reuse.messages, ...source.slice(reuse.source)] : source;
    const layers: ContextLayer[] = [];
    const compacted = est([history]) > HIGH_WATERMARK * historyBudget;
    if (compacted) {
      history = await this.reduce(history, LOW_WATERMARK * historyBudget, est, policy, input, layers, false);
      this.prefixes.set(budget.window, { source: source.length, messages: history });
    }
    const head = headLength(history);
    const report: ContextReport = {
      ref: input.candidate.ref, window: budget.window, input: budget.input, history: historyBudget,
      estimated: { system, tools, task: est([history.slice(0, head)]), history: est([history.slice(head)]), attachments },
      factor, layers, compacted,
    };
    this.last = report;
    return {
      messages: [...history, ...evidence.attachments], historyLength: history.length,
      estimatedInputTokens: system + tools + est([history]) + attachments, report,
      evidenceIds: evidence.evidenceIds, incompleteEvidenceIds: evidence.incompleteEvidenceIds, presentedEvidence: evidence.presentedEvidence,
    };
  }

  /** 强制执行 L1–L3（供 /compact）；判定阶段不允许摘要时抛错。调用方以返回值替换自身历史。 */
  async compact(messages: ModelMessage[], input: PrepareInput): Promise<ModelMessage[]> {
    if (!this.summaryAllowed) throw new Error(`${this.options.stage} 阶段不允许模型摘要`);
    input.signal.throwIfAborted();
    const { est, budget, policy, system, tools, factor } = this.measure(input);
    const layers: ContextLayer[] = [];
    const history = await this.reduce(demoteAttachments(messages), 0, est, policy, input, layers, true);
    this.prefixes.clear();
    const head = headLength(history);
    this.last = {
      ref: input.candidate.ref, window: budget.window, input: budget.input, history: budget.input,
      estimated: { system, tools, task: est([history.slice(0, head)]), history: est([history.slice(head)]), attachments: 0 },
      factor, layers, compacted: true,
    };
    return history;
  }

  private factor(ref: string): number {
    return this.factors.get(ref) ?? 1;
  }

  private measure(input: PrepareInput) {
    const factor = this.factor(input.candidate.ref);
    const est: Estimate = inputs => Math.ceil(estimateTokens(inputs) * factor);
    const system = est([input.system]);
    const tools = est([input.toolSchemas]);
    const budget = deriveBudget(input.candidate.contextWindow, system + tools);
    return { est, budget, policy: derivePolicy(budget, this.options.policy), system, tools, factor };
  }

  /** 依次执行 L1、L2、L3，达到目标即停；force 时三层全部执行。 */
  private async reduce(history: ModelMessage[], target: number, est: Estimate, policy: ResolvedPolicy, input: PrepareInput, layers: ContextLayer[], force: boolean): Promise<ModelMessage[]> {
    let next = compressContext(history, policy).messages;
    layers.push('L1');
    if (!force && est([next]) <= target) return next;
    next = stripToolResults(next, policy.retainRecentToolRounds);
    layers.push('L2');
    if (!force && est([next]) <= target) return next;
    if (!this.summaryAllowed) return next;
    const head = headLength(next);
    const tail = lastRoundStart(next);
    if (tail <= head) return next;
    const older = next.slice(head, tail);
    const summary = await this.options.summarize!(older, {
      candidate: input.candidate, signal: input.signal, maxChars: Math.max(1_000, Math.floor(target || policy.maxToolChars)),
      ...(input.usageObserver ? { usageObserver: input.usageObserver } : {}),
      ...(input.usageObservationScope ? { usageObservationScope: input.usageObservationScope } : {}),
    });
    if (summary === undefined) return next;
    layers.push('L3');
    return [...next.slice(0, head), summaryMessage(summary, collectHistoryEvidenceIds(older)), ...next.slice(tail)];
  }
}
