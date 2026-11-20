import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { ContextManager, collectHistoryEvidenceIds, LOW_WATERMARK, SUMMARY_MARKER, type Summarizer } from '../src/index';
import { scriptedModel } from '../src/testing/scripted-model';

const candidate = (contextWindow: number, ref = 'mock:a') => ({ ref, model: scriptedModel([]), contextWindow });
const input = (contextWindow = 40_000) => ({ candidate: candidate(contextWindow), system: 's', toolSchemas: [], signal: new AbortController().signal });
const task: ModelMessage = { role: 'user', content: '用例：登录后看到首页' };
const round = (i: number, size: number): ModelMessage[] => [
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'echo', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'echo', output: { type: 'json', value: { evidenceIds: [`e${i}`], body: 'x'.repeat(size) } } }] },
];
const rounds = (n: number, size: number) => Array.from({ length: n }, (_, i) => round(i, size)).flat();
// 40K 窗口：可用输入约 32975 token，85% 水位约 28000 token（约 84000 个 ASCII 字符）
const small = (): ModelMessage[] => [task, ...rounds(3, 9_000)];
const large = (): ModelMessage[] => [task, ...rounds(12, 9_000)];
const chatty = (): ModelMessage[] => [task, ...Array.from({ length: 4 }, (): ModelMessage => ({ role: 'assistant', content: 'y'.repeat(30_000) })), ...round(9, 10)];

describe('ContextManager', () => {
  it('水位线以下不压缩，历史原样保留', async () => {
    const manager = new ContextManager({ stage: 'execute' });
    const messages = small();
    const prepared = await manager.prepare(messages, input());
    // 无 presenter 时历史后会追加“证据不完整”提示（现有语义），只比较历史部分。
    expect(prepared.messages.slice(0, prepared.historyLength)).toEqual(messages);
    expect(prepared.historyLength).toBe(messages.length);
    expect(prepared.report).toMatchObject({ compacted: false, layers: [], window: 40_000 });
  });

  it('超过水位线时逐层裁剪到 60% 以下，首条任务不变，证据 ID 保留', async () => {
    const manager = new ContextManager({ stage: 'execute' });
    const prepared = await manager.prepare(large(), input());
    const { report } = prepared;
    expect(report.compacted).toBe(true);
    expect(report.layers).toEqual(['L1', 'L2']);
    expect(report.estimated.task + report.estimated.history).toBeLessThanOrEqual(LOW_WATERMARK * report.history);
    expect(prepared.messages[0]).toEqual(task);
    expect(collectHistoryEvidenceIds(prepared.messages).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `e${i}`).sort());
  });

  it('压缩后追加消息时复用定稿前缀，前缀字节不变', async () => {
    const manager = new ContextManager({ stage: 'execute' });
    const messages = large();
    const first = await manager.prepare(messages, input());
    const second = await manager.prepare([...messages, ...round(99, 10)], input());
    expect(second.report.compacted).toBe(false);
    expect(JSON.stringify(second.messages.slice(0, first.historyLength))).toBe(JSON.stringify(first.messages.slice(0, first.historyLength)));
    expect(second.historyLength).toBe(first.historyLength + 2);
  });

  it('窗口不同的候选不复用定稿前缀，独立裁剪', async () => {
    const manager = new ContextManager({ stage: 'execute' });
    const messages = large();
    await manager.prepare(messages, input(40_000));
    const wide = await manager.prepare(messages, input(400_000));
    expect(wide.report.compacted).toBe(false);
    expect(wide.messages.slice(0, wide.historyLength)).toEqual(messages);
  });

  it('execute 阶段即使 L2 后仍超限也不调用摘要', async () => {
    const summarize = vi.fn<Summarizer>(async () => '{}');
    const manager = new ContextManager({ stage: 'execute', summarize });
    expect(manager.summaryAllowed).toBe(false);
    const prepared = await manager.prepare(chatty(), input());
    expect(summarize).not.toHaveBeenCalled();
    expect(prepared.report.layers).not.toContain('L3');
  });

  it('prepare 阶段即使 L2 后仍超限也不调用摘要', async () => {
    const summarize = vi.fn<Summarizer>(async () => '{}');
    const manager = new ContextManager({ stage: 'prepare', summarize });
    expect(manager.summaryAllowed).toBe(false);
    const prepared = await manager.prepare(chatty(), input());
    expect(summarize).not.toHaveBeenCalled();
    expect(prepared.report.layers).not.toContain('L3');
  });

  it('plan 阶段在 L2 后仍超限时调用摘要，替换较早消息并保留首条任务与最近一轮', async () => {
    const summarize = vi.fn<Summarizer>(async () => '{"goal":"登录"}');
    const manager = new ContextManager({ stage: 'plan', summarize });
    const messages = chatty();
    const prepared = await manager.prepare(messages, input());
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(prepared.report.layers).toEqual(['L1', 'L2', 'L3']);
    expect(prepared.messages[0]).toEqual(task);
    expect((prepared.messages[1] as { content: string }).content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(prepared.messages.slice(0, prepared.historyLength).slice(-2)).toEqual(messages.slice(-2));
  });

  it('摘要失败时退回 L2 结果', async () => {
    const manager = new ContextManager({ stage: 'plan', summarize: async () => undefined });
    const prepared = await manager.prepare(chatty(), input());
    expect(prepared.report.layers).toEqual(['L1', 'L2']);
    expect(JSON.stringify(prepared.messages)).not.toContain(SUMMARY_MARKER);
  });

  it('摘要保留被替换区间的证据 ID', async () => {
    const manager = new ContextManager({ stage: 'plan', summarize: async () => '{}' });
    const messages: ModelMessage[] = [task, ...round(1, 10), { role: 'assistant', content: 'y'.repeat(100_000) }, ...round(2, 10)];
    const prepared = await manager.prepare(messages, input());
    expect(prepared.report.layers).toContain('L3');
    expect(collectHistoryEvidenceIds(prepared.messages)).toEqual(expect.arrayContaining(['e1', 'e2']));
  });

  it('校准系数只升不降并体现在报告与估算中', async () => {
    const manager = new ContextManager({ stage: 'execute' });
    const before = await manager.prepare(small(), input());
    manager.observe('mock:a', 100, 200);
    manager.observe('mock:a', 100, 150);
    manager.observe('mock:a', 100, undefined);
    const after = await manager.prepare(small(), input());
    expect(after.report.factor).toBe(2);
    expect(after.estimatedInputTokens).toBeGreaterThan(before.estimatedInputTokens * 1.9);
  });

  it('compact 在判定阶段抛错，在允许摘要的阶段强制执行 L3', async () => {
    await expect(new ContextManager({ stage: 'review', summarize: async () => '{}' }).compact(small(), input())).rejects.toThrow(/不允许模型摘要/);
    const manager = new ContextManager({ stage: 'plan', summarize: async () => '{"goal":"g"}' });
    const out = await manager.compact([task, ...rounds(3, 100)], input());
    expect(out[0]).toEqual(task);
    expect(JSON.stringify(out)).toContain(SUMMARY_MARKER);
    expect(manager.report()?.layers).toContain('L3');
  });

  it('附件按 ID 物化在历史之后，不进入历史长度', async () => {
    const manager = new ContextManager({ stage: 'execute', presenter: async ids => ids.map(id => ({ id, type: 'dom' as const, text: '页面', truncated: false })) });
    const messages = small();
    const prepared = await manager.prepare(messages, input());
    expect(prepared.historyLength).toBe(messages.length);
    expect(prepared.messages.length).toBeGreaterThan(messages.length);
    expect(prepared.presentedEvidence.map(e => e.id)).toEqual(['e0', 'e1', 'e2']);
  });
});
