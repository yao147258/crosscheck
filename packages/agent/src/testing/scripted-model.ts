import { MockLanguageModelV4 } from 'ai/test';

export type ScriptStep =
  /** truncated 模拟输出达到 max_tokens 上限，finishReason 为 length */
  | { text: string; truncated?: boolean }
  | { toolCalls: Array<{ name: string; input: unknown }>; truncated?: boolean }
  | { error: Error }
  /** 永远不返回结果，直到调用方的 abortSignal 中止；中止后以 TimeoutError 拒绝，模拟模型调用超时 */
  | { hang: true }
  /** 与 hang 相同，但中止后以不带特殊 name 的普通错误拒绝，用于验证“信号已中止”这条判定路径 */
  | { hangWithGenericError: true };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/**
 * 按脚本逐次返回结果的假模型，用于确定性地测试代理循环。
 * 每次 doGenerate 消耗一个脚本步骤；调用记录见 model.doGenerateCalls。
 */
export function scriptedModel(steps: ScriptStep[]): MockLanguageModelV4 {
  let index = 0;
  let callSeq = 0;
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      const step = steps[index++];
      if (!step) throw new Error(`脚本已耗尽：第 ${index} 次调用没有预设响应`);
      if ('error' in step) throw step.error;
      if ('hang' in step) {
        // 模拟真实超时的 provider：在 abortSignal 中止前一直挂起，中止后以 TimeoutError 拒绝
        return new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('模型调用超时'), { name: 'TimeoutError' })),
            { once: true },
          );
        });
      }
      if ('hangWithGenericError' in step) {
        return new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(new Error('连接中断')), { once: true });
        });
      }
      if ('text' in step) {
        return {
          content: [{ type: 'text' as const, text: step.text }],
          finishReason: { unified: step.truncated ? 'length' as const : 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: step.toolCalls.map((c) => ({
          type: 'tool-call' as const,
          toolCallId: `call-${++callSeq}`,
          toolName: c.name,
          input: JSON.stringify(c.input),
        })),
        finishReason: { unified: step.truncated ? 'length' as const : 'tool-calls' as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}
