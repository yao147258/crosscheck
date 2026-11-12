import { MockLanguageModelV4 } from 'ai/test';

export type ScriptStep =
  | { text: string }
  | { toolCalls: Array<{ name: string; input: unknown }> }
  | { error: Error };

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
    doGenerate: async () => {
      const step = steps[index++];
      if (!step) throw new Error(`脚本已耗尽：第 ${index} 次调用没有预设响应`);
      if ('error' in step) throw step.error;
      if ('text' in step) {
        return {
          content: [{ type: 'text' as const, text: step.text }],
          finishReason: { unified: 'stop' as const, raw: undefined },
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
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}
