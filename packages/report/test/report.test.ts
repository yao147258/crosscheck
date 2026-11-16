import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { ArtifactStore, CaseResultSchema, contentHash, type EvidenceRecord } from '@crosscheck/core';
import { RunStore } from '@crosscheck/runner';
import { generateReport, renderJunit } from '../src/index';
import { RunResultSchema } from '@crosscheck/core';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const attack = '</script><svg onload="globalThis.pwned=1">&\'\"';
const exec = promisify(execFile);

/** Windows 使用系统 XML 解析器；其他平台要求 Python 标准库，不增加 npm 解析依赖，也不静默跳过。 */
async function parseXml(file: string): Promise<{ message: string; text: string }> {
  const parsed = process.platform === 'win32'
    ? await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $doc=[System.Xml.XmlDocument]::new(); $doc.Load($env:CROSSCHECK_XML_FILE); @{message=$doc.SelectSingleNode("//skipped").GetAttribute("message");text=$doc.SelectSingleNode("//system-out").InnerText}|ConvertTo-Json -Compress'], { env: { ...process.env, CROSSCHECK_XML_FILE: file }, encoding: 'utf8' })
    : await exec('python3', ['-c', 'import json,sys,xml.etree.ElementTree as ET; root=ET.parse(sys.argv[1]).getroot(); print(json.dumps({"message":root.find(".//skipped").attrib["message"],"text":root.find(".//system-out").text},ensure_ascii=True))', file]);
  return JSON.parse(parsed.stdout.trim());
}

it.each([0xfffe, 0xffff].flatMap(invalid => ['attribute', 'text'].map(position => ({ invalid, position }))))('fix1 I1：真实XML解析 $position 位置的非法码点 $invalid，保留补充平面字符', async ({ invalid, position }) => {
  const { artifacts, run } = await fixture('BLOCKED');
  const original = await artifacts.readJson(`runs/${run.manifest.runId}/results.json`, RunResultSchema);
  const supplementary = String.fromCodePoint(0x1f600, 0x20000);
  const input = `服务返回${String.fromCodePoint(invalid)}文本${supplementary}<&"'`;
  const expected = `服务返回�文本${supplementary}<&"'`;
  const saved = RunResultSchema.parse({ ...original, cases: original!.cases.map(c => ({ ...c, reason: position === 'attribute' ? input : supplementary, suggestions: [position === 'text' ? input : supplementary] })) });
  const file = `runs/${run.manifest.runId}/parser-regression.xml`;
  await artifacts.writeBytes(file, Buffer.from(renderJunit(saved)));
  const parsed = await parseXml(artifacts.resolve(file));
  expect(parsed.message).toBe(`BLOCKED: ${position === 'attribute' ? expected : supplementary}`);
  expect(JSON.parse(parsed.text).suggestions).toEqual([position === 'text' ? expected : supplementary]);
});
async function fixture(status = 'PASS', png = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'report10-')); roots.push(root);
  const artifacts = new ArtifactStore(root);
  const display = { clauses: [{ id: 'M-AC-1', text: attack, source: { file: attack, line: 1, excerpt: attack } }], cases: [{ id: 'M-TC-1', covers: ['M-AC-1'], actor: 'guest', steps: [attack], expectations: [{ id: 'E1', text: attack, evidence: ['network'] }] }] };
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const run = await RunStore.create(artifacts, { fingerprint, environment: 'local', selectedCaseIds: ['M-TC-1'] }, { version: 1, policy: 'plan2-task9-http-db-v1', fingerprint, sourceFingerprint: fingerprint, display, displayDigest: contentHash(display) });
  const prefix = `runs/${run.manifest.runId}/cases/M-TC-1/attempts/1`;
  const bytes = png ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5o8AAAAASUVORK5CYII=', 'base64') : Buffer.from(attack);
  const record: EvidenceRecord = { id: 'e-fixture', type: png ? 'screenshot' : 'console', mime: png ? 'image/png' : 'text/html', runId: run.manifest.runId, caseId: 'M-TC-1', attempt: 1, actionId: 'a-fixture', phase: 'execution', time: new Date().toISOString(), path: `${prefix}/evidence/files/e-fixture.${png ? 'png' : 'txt'}`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, redacted: true };
  await artifacts.writeBytes(record.path, bytes);
  const verdict = status === 'FAIL' ? 'fail' : status === 'UNCLEAR' ? 'unclear' : 'pass';
  const judgement = { expectationId: 'E1', verdict, evidenceIds: [record.id], reasoning: attack };
  const result = CaseResultSchema.parse({ runId: run.manifest.runId, caseId: 'M-TC-1', attempt: 1, start: record.time, end: record.time, budget: { limits: { steps: 10, tokens: 100, minutes: 1 }, used: { steps: 2, tokens: 30, elapsedMs: 1 }, exhausted: false, reason: null }, complete: true, status, expectations: [{ expectationId: 'E1', executor: judgement, reviewer: status === 'DISPUTED' ? { ...judgement, verdict: 'fail' } : status === 'BLOCKED' ? null : judgement, status }], usage: { inputTokens: 20, outputTokens: 10, pricingKnown: false, cost: null }, reliability: { attempts: 2, errors: [attack] }, suggestions: [attack], drift: [attack] });
  await run.withLock(async () => { await run.commitCase(result, [], [record]); await run.updateStatus('completed'); await run.rebuildSummary(); });
  return { root, artifacts, run, record };
}

it.each(['PASS', 'FAIL', 'DISPUTED', 'UNCLEAR', 'BLOCKED'])('同源生成%s，未知费用/原状态与恶意文本不丢失', async status => {
  const { artifacts, run } = await fixture(status);
  const report = await generateReport(artifacts, run.manifest.runId);
  expect(report.result.status).toBe(status);
  const xml = (await artifacts.readBytes(`runs/${run.manifest.runId}/junit.xml`))!.toString();
  expect(xml.includes('<failure ')).toBe(status === 'FAIL');
  expect(xml.includes('<skipped ')).toBe(!['PASS', 'FAIL'].includes(status));
  expect(xml).toContain(`value="${status}"`); expect(xml).not.toContain('<svg');
  const html = (await artifacts.readBytes(report.htmlPath))!.toString();
  for (const text of ['条款 / 预期矩阵', '双方判断', '证据时间线', '请求 / 响应', '未知', '低可靠', '夹具建议', '漂移提示', '无截图证据']) expect(html).toContain(text);
  expect(html).not.toContain('<svg'); expect(html).not.toContain('<script'); expect(html).not.toContain('href="http'); expect(html).toContain('&lt;/script&gt;');
  expect(JSON.parse((await artifacts.readBytes(`runs/${run.manifest.runId}/results.json`))!.toString()).status).toBe(status);
});
it('PNG仅用已验证合成fixture静态内嵌，不声明生产采集支持', async () => {
  const { artifacts, run } = await fixture('PASS', true); const report = await generateReport(artifacts, run.manifest.runId);
  const html = (await artifacts.readBytes(report.htmlPath))!.toString(); expect(html).toContain('data:image/png;base64,'); expect(html).not.toContain('无截图证据');
});
it.each(['bytes', 'path', 'snapshot', 'result', 'summary', 'reference'])('拒绝损坏或越界%s，不修补历史结果', async kind => {
  const { artifacts, run, record } = await fixture(); const base = `runs/${run.manifest.runId}`;
  if (kind === 'bytes') await artifacts.writeBytes(record.path, Buffer.from('tampered'));
  if (kind === 'path') await artifacts.writeJson(`${base}/cases/M-TC-1/attempts/1/evidence/index.json`, [{ ...record, path: 'runs/another/secret.txt' }]);
  if (kind === 'snapshot') { const saved = JSON.parse((await artifacts.readBytes(`${base}/input.json`))!.toString()); saved.display.clauses[0].text = 'tampered'; await artifacts.writeJson(`${base}/input.json`, saved); }
  if (kind === 'result') await artifacts.writeJson(`${base}/cases/M-TC-1/attempts/1/result.json`, { status: 'PASS' });
  if (kind === 'summary') await artifacts.writeJson(`${base}/results.json`, { status: 'PASS' });
  if (kind === 'reference') { const file = `${base}/cases/M-TC-1/attempts/1/result.json`; const saved = JSON.parse((await artifacts.readBytes(file))!.toString()); saved.expectations[0].executor.evidenceIds = ['e-missing']; await artifacts.writeJson(file, saved); }
  await expect(generateReport(artifacts, run.manifest.runId)).rejects.toThrow();
  expect(await artifacts.readBytes(`${base}/report/index.html`)).toBeUndefined();
});
