import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { collectHistoryEvidenceIds, demoteAttachments, materializeEvidence, stripToolResults, summaryMessage, SUMMARY_MARKER } from '../src/index';

const round = (i: number, body = 'x'.repeat(100)): ModelMessage[] => [
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'echo', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'echo', output: { type: 'json', value: { evidenceIds: [`e${i}`], body } } }] },
];

describe('确定性裁剪层', () => {
  it('stripToolResults 只保留最近 keep 轮完整结果，更早结果降为 {tool, ok, evidenceIds}', () => {
    const history: ModelMessage[] = [{ role: 'user', content: '任务' }, ...round(1), ...round(2), ...round(3)];
    const out = stripToolResults(history, 1);
    expect(out[0]).toEqual(history[0]);
    expect(out.slice(-2)).toEqual(history.slice(-2));
    expect(JSON.stringify(out[2])).not.toContain('xxxx');
    expect((out[2] as { content: Array<{ output: unknown }> }).content[0]!.output).toEqual({ type: 'json', value: { stripped: true, tool: 'echo', ok: true, evidenceIds: ['e1'] } });
    expect(out.filter(m => m.role === 'assistant')).toEqual(history.filter(m => m.role === 'assistant'));
  });

  it('错误结果标记 ok=false', () => {
    const history: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'echo', output: { type: 'error-text', value: '失败' } }] },
      ...round(2),
    ];
    expect(JSON.stringify(stripToolResults(history, 1)[1])).toContain('"ok":false');
  });

  it('collectHistoryEvidenceIds 收集工具结果、附件占位与摘要中的 ID', () => {
    const history: ModelMessage[] = [
      ...round(1),
      { role: 'user', content: '[宿主证据 e-att]\n[compressed; truncated]' },
      summaryMessage('{"goal":"g"}', ['e-sum']),
    ];
    expect(collectHistoryEvidenceIds(history).sort()).toEqual(['e-att', 'e-sum', 'e1']);
    expect((summaryMessage('s', []) as { content: string }).content.startsWith(SUMMARY_MARKER)).toBe(true);
  });

  it('demoteAttachments 把附件消息降为 ID 占位', () => {
    const out = demoteAttachments([{ role: 'user', content: [{ type: 'text', text: '[宿主证据 e9]\n类型=dom' }, { type: 'text', text: '正文' }] }]);
    expect(out).toEqual([{ role: 'user', content: '[宿主证据 e9]\n[compressed; truncated]' }]);
  });

  it('materializeEvidence 按 ID 物化并标记缺失', async () => {
    const r = await materializeEvidence(['e1', 'e2'], {
      ref: 'mock:a', signal: new AbortController().signal,
      presenter: async () => [{ id: 'e1', type: 'dom', text: '页面', truncated: false }],
    });
    expect(r.presentedEvidence).toEqual([{ id: 'e1', type: 'dom', truncated: false }]);
    expect(r.incompleteEvidenceIds).toEqual(['e2']);
    expect(JSON.stringify(r.attachments)).toContain('宿主证据不完整');
  });
});
