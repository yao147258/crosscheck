import { ArtifactStore } from '@crosscheck/core';
import type { RunSuiteOptions } from '@crosscheck/runner';
import { HELP, parseArgs } from './args';
import { runCommand } from './run';
import { writeReport } from './report';
export { parseArgs } from './args';

export async function cliMain(argv: string[], options: { log?: (s: string) => void; dependencies?: Pick<RunSuiteOptions, 'modelOptions' | 'resilience' | 'env'>; signal?: AbortSignal } = {}): Promise<number> {
  const log = options.log ?? console.log;
  let args;
  try { args = parseArgs(argv); } catch (error) { log(error instanceof Error ? error.message : '参数错误'); return 2; }
  if (args.command === 'help') { log(HELP); return 0; }
  try {
    if (args.command === 'run') return await runCommand(args, log, options.dependencies, options.signal);
    await writeReport(new ArtifactStore(args.project), args.runId!, args.open, log);
    return 0;
  } catch { log('宿主存储、证据校验或报告操作失败'); return 3; }
}
