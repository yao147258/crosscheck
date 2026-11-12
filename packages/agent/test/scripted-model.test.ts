import { generateText, jsonSchema, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { scriptedModel } from '../src/testing/scripted-model';

describe('scriptedModel', () => {
  it('按脚本依次返回文本和工具调用', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'echo', input: { x: 1 } }] }, { text: '完成' }]);
    const tools = { echo: tool({ description: 'echo', inputSchema: jsonSchema({ type: 'object' }) }) };

    const r1 = await generateText({ model, prompt: 'hi', tools });
    expect(r1.finishReason).toBe('tool-calls');
    expect(r1.toolCalls[0]).toMatchObject({ toolName: 'echo', input: { x: 1 } });

    const r2 = await generateText({ model, prompt: 'hi' });
    expect(r2.text).toBe('完成');
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('脚本耗尽时报错', async () => {
    const model = scriptedModel([]);
    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow(/脚本已耗尽/);
  });

  it('可以模拟模型调用失败', async () => {
    const model = scriptedModel([{ error: new Error('503') }]);
    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow('503');
  });
});
