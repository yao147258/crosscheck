import { PROFILE_FILES, type ImpactReport, type ImpactSnapshot } from '@crosscheck/core';

const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
// 标识也可能来自文件名；同时转义 ANSI、换行和双向控制符，防止终端注入。
const text = (value: string) => [...value].map((char) => {
  const code = char.charCodeAt(0);
  return code < 32 || code >= 127 && code <= 159 || code >= 8232 && code <= 8238 || /\p{Bidi_Control}/u.test(char)
    ? `\\u${code.toString(16).padStart(4, '0')}` : char;
}).join('');
const unique = (items: string[]) => [...new Set(items)].sort(order);
const fields = new Set(['text', 'source', 'status', 'notes', 'id', 'covers', 'fixtures', 'actor', 'steps', 'expectations', 'baseURL', 'healthcheck', 'reset', 'start', 'stop', 'kind', 'environment', 'actions', 'env', 'inject', 'command', 'method', 'path', 'description', 'knowledge', 'sources', 'sql', 'parameters', 'operation', 'body', 'query', 'params', 'connection', 'requirementsDocs', 'budget', 'defaultEnvironment', 'allowedHosts', 'forbidden', 'redactFields', 'screenshotMasks', 'deniedHosts', 'allowPrivateNetworks', 'maxConcurrency', 'maxRequests', 'timeoutMs', 'redaction']);

function fieldPath(path: string): string {
  if (path === '/') return '/';
  const parts = path.slice(1).split('/');
  const root = parts[0]!;
  if (!fields.has(root)) return '/[redacted]';
  // 自由 JSON、命令环境映射等永远折叠；动态键即使看似普通字段也不可信。
  if (['body', 'params', 'env', 'command', 'start', 'stop', 'redaction'].includes(root)) return `/${root}`;
  if (parts.length === 1) return `/${root}`;
  if (/^\/budget\/perCase(\/(steps|tokens|minutes))?$/.test(path)) return path;
  if (root === 'source' && parts.length === 2 && ['file', 'line', 'excerpt'].includes(parts[1]!)) return path;
  if (/^\/(covers|fixtures|steps|knowledge|requirementsDocs|allowedHosts|deniedHosts|redactFields|screenshotMasks)\/\d+$/.test(path)) return path;
  if (/^\/(sources|expectations|parameters|actions)\/\d+(\/(file|line|excerpt|id|text|evidence|name|type|nullable|kind|url|selector|env)(\/\d+)?)?$/.test(path)) return path;
  if (/^\/forbidden\/\d+(\/(method|path))?$/.test(path)) return path;
  if (/^\/(connection|inject)\/(kind|env|name|storage)$/.test(path)) return path;
  return `/${root}`;
}

const descriptions = new Set([
  '项目笔记未记录结构化来源依赖，需人工复核。',
  '全局安全条件发生变化，需复核用例。',
  '自然语言步骤未记录结构化依赖，无法证明无关。',
  '默认环境变化，需复核用例。',
]);
const messages: Record<string, string> = {
  'file-limit': '两侧相关文件候选并集超过 2000 个上限，未检查范围无法确认',
  'analysis-limit': '分析或输出达到资源上限，结果已截断，请缩小范围复核',
  'invalid-profile': '七画像跨文件校验失败，请复核引用、参数及连接配置',
  'restricted-input': '路径不安全或资源超限', 'invalid-file': '文件编码、格式或内容无效',
  'missing-document': '登记的需求文档不存在', 'missing-config': '项目配置不存在',
  'missing-artifact': '工件不存在，分析范围不完整', 'duplicate-id': '实体标识重复',
  'duplicate-key': '节点键重复', 'missing-reference': '引用不存在，请复核相关工件',
  'invalid-source': '来源路径无效', 'concurrent-change': '读取期间文件或目录发生变化',
  'history-incomplete': '当前文件没有基线历史，可能未跟踪或被忽略',
  'input-error': '输入或基线不可用，无法完成分析', 'host-error': '宿主读取失败，无法完成分析', 'cancelled': '分析已取消',
};

// 仅投影公开报告 DTO，绝不遍历或序列化节点值、异常或内部快照。
export function projectImpactReport(report: ImpactReport, current?: ImpactSnapshot): ImpactReport {
  const changes = report.changes.map((change) => ({ key: text(change.key), kind: change.kind, fields: unique(change.fields.map(fieldPath)) })).sort((a, b) => order(a.key, b.key));
  const impacts = report.impacts.map((impact) => ({
    key: text(impact.key), certainty: impact.certainty,
    reasons: impact.reasons.map((reason) => ({ source: text(reason.source), chain: reason.chain.map(text), certainty: reason.certainty, side: reason.side,
      ...(reason.description && descriptions.has(reason.description) ? { description: reason.description } : {}),
    }))
      .sort((a, b) => order(JSON.stringify(a), JSON.stringify(b))),
  })).sort((a, b) => order(a.key, b.key));
  const advisories = report.advisories.map(text);
  const currentKeys = new Set(current?.nodes.map((node) => node.key));
  for (const key of unique([...report.changes.map((change) => change.key), ...report.impacts.map((impact) => impact.key)])) {
    if (currentKeys.has(key) && /^(clause|case|profile|notes):/.test(key)) advisories.push(`请使用 review 复核相关对象：${text(key)}`);
  }
  if (report.changes.some((change) => /^(clause|document):/.test(change.key))) advisories.push('请核对 reqs 条款范围与 plan 用例覆盖；重新运行测试不会重建已确认工件。');
  if (report.changes.some((change) => change.key === 'notes:project')) {
    advisories.push('项目笔记发生变化，请通过 profile 和 review 人工复核七份画像；不自动重建已确认工件。');
    for (const file of PROFILE_FILES) advisories.push(`请复核画像范围（不代表存在受影响实体）：${file}`);
  }
  const projected: ImpactReport = {
    version: 1, baseline: /^[a-f0-9]{40,64}$/.test(report.baseline) ? report.baseline : '', complete: report.complete,
    changes, impacts,
    diagnostics: report.diagnostics.map((diagnostic) => ({
      code: Object.hasOwn(messages, diagnostic.code) ? diagnostic.code : 'analysis-gap',
      ...(diagnostic.side ? { side: diagnostic.side } : {}),
      ...(diagnostic.file !== undefined ? { file: text(diagnostic.file) } : {}),
      message: messages[diagnostic.code] ?? '分析存在缺口，请复核输入',
    })).sort((a, b) => order(JSON.stringify(a), JSON.stringify(b))),
    limitations: unique(report.limitations.map(text)), advisories: unique(advisories),
  };
  // 转义和 CLI 建议也计入公开输出；按稳定前缀保留，而非静默超量。
  const reserve = 1000;
  let remaining = 2000000 - reserve;
  let limited = false;
  const bounded = <T>(items: T[]): T[] => {
    const kept: T[] = [];
    for (const item of items) {
      const size = JSON.stringify(item).length + 1;
      if (size > remaining) { limited = true; break; }
      remaining -= size; kept.push(item);
    }
    return kept;
  };
  projected.changes = bounded(projected.changes);
  projected.impacts = bounded(projected.impacts);
  projected.diagnostics = bounded(projected.diagnostics);
  projected.limitations = bounded(projected.limitations);
  projected.advisories = bounded(projected.advisories);
  if (limited) {
    projected.complete = false;
    if (!projected.diagnostics.some((d) => d.code === 'analysis-limit')) projected.diagnostics.push({ code: 'analysis-limit', message: messages['analysis-limit']! });
  }
  return projected;
}

export function formatImpactText(report: ImpactReport): string {
  const lines = [`基线：${report.baseline || '未解析'}`, '目标：当前磁盘', `分析：${report.complete ? '完整' : '不完整'}`, '实际变更：'];
  for (const change of report.changes) lines.push(`  ${change.key} ${change.kind} 字段 ${change.fields.join(', ')} [${change.kind === 'added' ? 'current' : change.kind === 'deleted' ? 'base' : 'base/current'}]`);
  if (!report.changes.length) lines.push('  无可确认变更');
  for (const [certainty, label] of [['definite', '显式依赖影响'], ['possible', '可能影响']] as const) {
    lines.push(`${label}：`);
    const impacts = report.impacts.filter((item) => item.certainty === certainty);
    if (!impacts.length) lines.push('  无已发现关联');
    for (const impact of impacts) {
      lines.push(`  ${impact.key}`);
      for (const reason of impact.reasons) {
        lines.push(`    [${reason.side}/${reason.certainty}] 来源 ${reason.source} 链 ${reason.chain.join(' -> ')}${reason.description ? `；${reason.description}` : ''}`);
      }
    }
  }
  lines.push('缺口：');
  for (const diagnostic of report.diagnostics) lines.push(`  [${diagnostic.side ?? 'unknown'}] ${diagnostic.code} ${diagnostic.file ?? ''}：${diagnostic.message}`);
  if (!report.diagnostics.length) lines.push('  无已知输入缺口');
  lines.push('建议：', ...report.advisories.map((item) => `  ${item}`), '限制：', ...report.limitations.map((item) => `  ${item}`));
  return lines.join('\n');
}
