import type { ArtifactStore, RunResult } from '@crosscheck/core';
import { RunStore } from '@crosscheck/runner';
import { loadReportData } from './results';
import { renderJunit } from './junit';
import { renderHtml } from './html';
export { renderJunit } from './junit';
export { renderHtml } from './html';
export type { ReportData, ReportEvidence } from './results';

export async function generateReport(artifacts: ArtifactStore, runId: string): Promise<{ result: RunResult; htmlPath: string }> {
  const run = await RunStore.load(artifacts, runId);
  return run.withLock(async () => {
    const current = await RunStore.load(artifacts, runId);
    const data = await loadReportData(artifacts, current);
    const root = `runs/${runId}`;
    const htmlPath = `${root}/report/index.html`;
    // 全部校验完成后才发布派生报告，不执行模型或更改提交点。
    await artifacts.writeJson(`${root}/results.json`, data.result);
    await artifacts.writeBytes(`${root}/junit.xml`, Buffer.from(renderJunit(data.result)));
    await artifacts.writeBytes(htmlPath, Buffer.from(renderHtml(data)));
    return { result: data.result, htmlPath };
  });
}
