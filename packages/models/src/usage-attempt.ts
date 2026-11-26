import { APICallError, gateway, wrapLanguageModel, type LanguageModel, type LanguageModelUsage } from 'ai';
import { getBuiltinRequestBoundary } from './providers';
import type { TokenUsage } from './usage';
import type { UsageAttempt, UsageObserver } from './usage-ledger';

/** 旧审计和预算沿用 SDK 归一化回执。 */
export function usageOf(usage: LanguageModelUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    ...(usage.inputTokenDetails?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.inputTokenDetails.cacheReadTokens } : {}),
    ...(usage.inputTokenDetails?.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens } : {}),
  };
}

type ProviderModel = Exclude<LanguageModel, string>;
type GenerateResult = Awaited<ReturnType<ProviderModel['doGenerate']>>;
type GenerateUsage = GenerateResult['usage'];

/** V2 只有读取缓存，V3/V4 使用嵌套计数。 */
function usageOfGenerate(usage: GenerateUsage): TokenUsage {
  const { inputTokens, outputTokens } = usage;
  const cacheReadTokens = typeof inputTokens === 'object' ? inputTokens.cacheRead : 'cachedInputTokens' in usage ? usage.cachedInputTokens : undefined;
  const cacheWriteTokens = typeof inputTokens === 'object' ? inputTokens.cacheWrite : undefined;
  return {
    inputTokens: typeof inputTokens === 'object' ? inputTokens.total : inputTokens,
    outputTokens: typeof outputTokens === 'object' ? outputTokens.total : outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function openAIReceipt(rawUsage: unknown): TokenUsage | null {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const usage = object(rawUsage);
  const details = object(usage?.input_tokens_details);
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  const cacheReadTokens = count(details?.cached_tokens);
  const cacheWriteTokens = count(details?.cache_write_tokens);
  const receipt = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
  return Object.keys(receipt).length ? receipt : null;
}

/** 在 SDK 完成预检后标记请求，可在后处理前捕获原始回执。 */
export function atGenerateBoundary(model: LanguageModel, onStart: () => void, onReceipt?: (usage: TokenUsage) => void) {
  const resolved = typeof model === 'string' ? (globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway).languageModel(model) : model;
  const builtin = getBuiltinRequestBoundary(resolved);
  const capture = <T extends { usage: GenerateUsage }>(result: PromiseLike<T>) => Promise.resolve(result).then(response => {
    try {
      // OpenAI 适配器会把缺失的缓存读归一成零；账本只接受原始回执。
      const usage = builtin?.type === 'openai'
        ? openAIReceipt('raw' in response.usage ? response.usage.raw : undefined)
        : usageOfGenerate(response.usage);
      if (usage) onReceipt?.(usage);
    } catch { /* 不覆盖 SDK 原有的后处理行为。 */ }
    return response;
  });
  // SDK 负责原有版本转换。旧版仅拦截原始 doGenerate，避免转换内容时抛错而丢掉回执。
  const legacy = !builtin && onReceipt && (resolved.specificationVersion === 'v2' || resolved.specificationVersion === 'v3');
  const provider = legacy ? new Proxy(resolved, {
    get(target, prop) {
      if (prop === 'doGenerate') {
        const generate = Reflect.get(target, prop, target) as ProviderModel['doGenerate'];
        return (options: { abortSignal?: AbortSignal }) => {
          options.abortSignal?.throwIfAborted();
          onStart();
          return capture<GenerateResult>(Reflect.apply(generate, target, [options]));
        };
      }
      const value = Reflect.get(target, prop, target);
      return prop === 'doStream' && typeof value === 'function' ? value.bind(target) : value;
    },
  }) : resolved;
  return wrapLanguageModel({
    model: provider,
    middleware: {
      wrapGenerate: ({ doGenerate, params }) => {
        params.abortSignal?.throwIfAborted();
        if (!legacy && !builtin) onStart();
        const result = builtin ? builtin.run(onStart, doGenerate) : doGenerate();
        return onReceipt && !legacy ? capture(result).catch(error => {
          // 复用 SDK 已消费并附在错误上的回执；不读取、复制或等待响应流。
          if (builtin?.type === 'openai' && APICallError.isInstance(error)) {
            try {
              const body = error.responseBody;
              const raw: { usage?: unknown } | null | undefined = typeof body === 'string' ? JSON.parse(body) : body;
              const receipt = openAIReceipt(raw?.usage);
              if (receipt) onReceipt(receipt);
            } catch { /* 无可用回执时仍保留原错误。 */ }
          }
          throw error;
        }) : result;
      },
    },
  });
}

export interface UsageObservationScope {
  enqueue(observer: UsageObserver | undefined, attempt: UsageAttempt): void;
  /** 在共享预算的整个业务结束后调用。重复排空不重复通知。 */
  flush(): Promise<void>;
}

/** 仅暂存已完成的模型事件；排空前不执行观察者，避免其影响整个业务的预算。 */
export function createUsageObservationScope(): UsageObservationScope {
  const pending: Array<{ observer: UsageObserver; attempt: UsageAttempt }> = [];
  let drained = Promise.resolve();
  return {
    enqueue(observer, attempt) {
      if (observer) pending.push({ observer, attempt });
    },
    flush() {
      const batch = pending.splice(0);
      drained = drained.then(async () => {
        for (const { observer, attempt } of batch) await notifyUsageAttempt(observer, attempt);
      });
      return drained;
    },
  };
}

/** 等待账本观察者完成，但不让观察者的异常影响模型调用或宿主审计。 */
export async function notifyUsageAttempt(observer: UsageObserver | undefined, attempt: UsageAttempt): Promise<void> {
  try { await observer?.(attempt); } catch { /* 用量通知失败不改变调用结果。 */ }
}
