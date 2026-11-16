import { ArtifactStore, GateError } from '@crosscheck/core';
import { HELP, parseArgs, type CliArgs } from './args';
import { InterruptedError, type CommandDependencies } from './context';
import { initCommand } from './init';
import { runCommand } from './run';
import { writeReport } from './report';
export { parseArgs } from './args';

export async function cliMain(argv: string[], options: { log?: (s: string) => void; dependencies?: CommandDependencies; signal?: AbortSignal } = {}): Promise<number> {
  const log = options.log ?? console.log;
  let args: CliArgs;
  try { args = parseArgs(argv); } catch (error) { log(error instanceof Error ? error.message : '参数错误'); return 2; }
  if (args.command === 'help') { log(HELP); return 0; }
  const deps = options.dependencies ?? {};
  try {
    switch (args.command) {
      case 'run': return await runCommand(args, log, deps, options.signal);
      case 'report': await writeReport(new ArtifactStore(args.project), args.runId!, args.open, log); return 0;
      case 'init': return await initCommand(args, log, deps, options.signal);
      default: throw new Error(`命令尚未实现：${args.command}`);
    }
  } catch (error) {
    if (args.command === 'run' || args.command === 'report') { log('宿主存储、证据校验或报告操作失败'); return 3; }
    if (error instanceof GateError || error instanceof InterruptedError) { log(error.message); return 2; }
    log(`宿主错误：${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
}
