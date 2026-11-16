import type { RunResult } from '@crosscheck/core';

/** 同时适用属性与文本；按码点替换 XML 1.0 禁止字符，保留合法补充平面字符。 */
export function escapeMarkup(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, '�').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
export function renderJunit(result: RunResult): string {
  const esc = escapeMarkup;
  const failures = result.cases.filter(c => c.status === 'FAIL').length;
  const skipped = result.cases.filter(c => !['PASS', 'FAIL'].includes(c.status)).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="${esc(result.manifest.runId)}" tests="${result.cases.length}" failures="${failures}" skipped="${skipped}"><properties><property name="status" value="${result.status}"/></properties>${result.cases.map(c => `<testcase classname="${esc(result.manifest.environment)}" name="${esc(c.caseId)}" time="${(Date.parse(c.end) - Date.parse(c.start)) / 1000}"><properties><property name="status" value="${c.status}"/><property name="complete" value="${c.complete}"/></properties>${c.status === 'FAIL' ? `<failure message="疑似 bug，待人工复核">${esc(JSON.stringify(c.expectations))}</failure>` : c.status !== 'PASS' ? `<skipped message="${c.status}: ${esc(c.reason ?? '未形成一致通过结论')}"/>` : ''}<system-out>${esc(JSON.stringify({ usage: c.usage, reliability: c.reliability, suggestions: c.suggestions, drift: c.drift }))}</system-out></testcase>`).join('')}</testsuite></testsuites>\n`;
}
