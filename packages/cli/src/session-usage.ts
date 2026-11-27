import type { UsageBucket, UsageReport } from '@crosscheck/models';

export function formatUsageTotal(bucket: UsageBucket, incomplete = false): string {
  return `调用 ${bucket.calls}${incomplete || bucket.unknownCalls > 0 ? ' · 统计不完整' : ''} · 未知调用 ${bucket.unknownCalls} · 已知输入 ${bucket.inputTokens} · 已知输出 ${bucket.outputTokens} · 已知缓存读 ${bucket.cacheReadTokens} · 已知缓存写 ${bucket.cacheWriteTokens} · 已知费用估算 ${bucket.cost}`;
}

function singleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function formatUsageReport(project: string, sessionId: string | undefined, report: UsageReport) {
  const lines: string[] = [];
  const truncateLineIndices: number[] = [];
  const addLabel = (label: string) => { truncateLineIndices.push(lines.length); lines.push(label); };
  addLabel(`${sessionId === undefined ? '项目累计' : '项目'}：${singleLine(project)}`);
  if (sessionId !== undefined) lines.push('会话 ID：', singleLine(sessionId));
  lines.push(`总计：${formatUsageTotal(report.total, report.incomplete)}`);
  for (const [label, group] of [['命令', report.byCommand], ['角色', report.byRole], ['模型', report.byModel]] as const) {
    lines.push(`按${label}分组：`);
    for (const key of Object.keys(group).sort()) {
      const heading = `  ${singleLine(key)}：`;
      const total = formatUsageTotal(group[key]!);
      if (label === '模型') {
        addLabel(heading);
        lines.push(`  ${total}`);
      } else lines.push(`${heading}${total}`);
    }
  }
  if (report.diagnostics.length) lines.push('诊断：', ...report.diagnostics.map(line => `  ${line}`));
  return { lines, truncateLineIndices };
}
