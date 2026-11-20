import { APICallError } from 'ai';
import { DEFAULT_CONTEXT_WINDOW } from './model-ref';

/** 单次请求的输出上限封顶，取主流模型的最高档 */
export const MAX_OUTPUT_TOKENS = 128_000;
/** 估算误差与协议开销的预留 */
const SAFETY_MARGIN = 1_024;
/** 可用输出低于此值时视为输入超出窗口 */
const MIN_OUTPUT_TOKENS = 1_024;

/** 单张图片的固定估算：按长边封顶后约 1600 token，宁多勿少。 */
export const IMAGE_TOKENS = 1_600;

/** 字节数组不能按 JSON 展开计数；Buffer 会先经 toJSON 变为 { type: 'Buffer', data } 再交给 replacer。 */
function isBinary(value: unknown): boolean {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return true;
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data);
}

/** 按字符粗估 token，宁多勿少：非 ASCII 字符每个计 1，ASCII 每 3 个计 1，图片按固定值。 */
export function estimateTokens(inputs: readonly unknown[]): number {
  let ascii = 0;
  let other = 0;
  let images = 0;
  const replacer = (_key: string, value: unknown) => {
    if (isBinary(value)) { images++; return ''; }
    return value;
  };
  for (const input of inputs) {
    const text = typeof input === 'string' ? input : JSON.stringify(input, replacer) ?? '';
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) < 128) ascii++;
      else other++;
    }
  }
  return other + Math.ceil(ascii / 3) + images * IMAGE_TOKENS;
}

/** 按已估算的输入 token 计算 maxOutputTokens；空间不足时抛出不可重试错误，避免发出注定失败的请求。 */
export function outputTokenLimitForEstimate(contextWindow: number = DEFAULT_CONTEXT_WINDOW, estimated: number): number {
  const available = contextWindow - estimated - SAFETY_MARGIN;
  if (available < MIN_OUTPUT_TOKENS) {
    throw new APICallError({
      message: `输入约 ${estimated} token，超出上下文窗口 ${contextWindow}；可在模型引用后用 [size] 调大窗口，如 model[1M]`,
      url: '', requestBodyValues: {}, isRetryable: false,
    });
  }
  return Math.min(available, MAX_OUTPUT_TOKENS);
}

/** 按上下文窗口减去估算输入得到 maxOutputTokens。 */
export function outputTokenLimit(contextWindow: number = DEFAULT_CONTEXT_WINDOW, inputs: readonly unknown[]): number {
  return outputTokenLimitForEstimate(contextWindow, estimateTokens(inputs));
}
