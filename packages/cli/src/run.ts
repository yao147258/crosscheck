import { ArtifactStore } from '@crosscheck/core';
import { runSuite, type RunSuiteOptions } from '@crosscheck/runner';
import type { CliArgs } from './args';
import { writeReport } from './report';

export async function runCommand(args: CliArgs, log: (s: string) => void, dependencies: Pick<RunSuiteOptions, 'modelOptions' | 'resilience' | 'env'> = {}, signal?: AbortSignal): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const artifacts = new ArtifactStore(args.project);
    const outcome = await runSuite({ ...dependencies, artifacts, modules: args.modules, caseIds: args.caseIds, environment: args.environment, resume: args.resume, signal: controller.signal });
    if (outcome.error) log(outcome.error);
    if (outcome.result) {
      log(`运行 ${outcome.result.manifest.runId} ${outcome.result.status}${outcome.result.status === 'FAIL' ? ' 疑似 bug，待人工复核' : ''}`);
      try { await writeReport(artifacts, outcome.result.manifest.runId, args.open, log); }
      catch { log('离线报告校验或写入失败；未修补历史结果'); return 3; }
    }
    return outcome.exitCode;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    signal?.removeEventListener('abort', abort);
  }
}
