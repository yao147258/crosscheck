import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { ArtifactStore } from '@crosscheck/core';
import { generateReport } from '@crosscheck/report';

export async function openReport(file: string): Promise<void> {
  const url = pathToFileURL(file).href;
  const program = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, argv, { shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('打开报告失败')));
  });
}
export async function writeReport(artifacts: ArtifactStore, runId: string, open: boolean, log: (s: string) => void): Promise<void> {
  const report = await generateReport(artifacts, runId);
  const file = artifacts.resolve(report.htmlPath);
  log(`报告 ${file}`);
  if (open) await openReport(file);
}
