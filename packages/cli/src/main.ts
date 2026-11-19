import { ArtifactStore, GateError } from '@crosscheck/core';
import { HELP, parseArgs, type CliArgs } from './args';
import { InterruptedError, type CommandDependencies } from './context';
import { initCommand } from './init';
import { impactCommand } from './impact';
import { profileCommand } from './profile';
import { planCommand } from './plan';
import { reqsCommand } from './reqs';
import { reviewCommand } from './review';
import { runCommand } from './run';
import { writeReport } from './report';
import { sessionCommand } from './session';
export { parseArgs } from './args';

export async function cliMain(argv: string[], options: { log?: (s: string) => void; dependencies?: CommandDependencies; signal?: AbortSignal } = {}): Promise<number> {
  const log = options.log ?? console.log;
  let args: CliArgs;
  try { args = parseArgs(argv); } catch (error) { log(error instanceof Error ? error.message : '参数错误'); return 2; }
  if (args.command === 'help') { log(HELP); return 0; }
  const deps = options.dependencies ?? {};
  try {
    switch (args.command) {
      case 'impact': return await impactCommand(args, log, options.signal);
      case 'session': return await sessionCommand(args, log, deps, options.signal);
      case 'run': return await runCommand(args, log, deps, options.signal);
      case 'report': await writeReport(new ArtifactStore(args.project), args.runId!, args.open, log); return 0;
      case 'profile': return await profileCommand(args, log, deps, options.signal);
      case 'init': return await initCommand(args, log, deps, options.signal);
      case 'reqs': return await reqsCommand(args, log, deps, options.signal);
      case 'plan': return await planCommand(args, log, deps, options.signal);
      case 'review': return await reviewCommand(args, log, deps, options.signal);
    }
  } catch (error) {
    if (args.command === 'run' || args.command === 'report') { log('宿主存储、证据校验或报告操作失败'); return 3; }
    if (error instanceof GateError || error instanceof InterruptedError) { log(error.message); return 2; }
    log(`宿主错误：${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
}
