import { ArtifactStore, resolveReviewer } from '@crosscheck/core';
import { createEditorHost, createOpener, runReview, type RunReviewOptions } from '@crosscheck/tui';
import type { CliArgs } from './args';
import { withInterrupt, type CommandDependencies } from './context';

export interface ReviewDependencies {
  isTTY?: boolean;
  userInfo?: () => { username: string };
  runReview?: (options: RunReviewOptions) => Promise<number>;
}

export async function reviewCommand(args: CliArgs, log: (s: string) => void, deps: CommandDependencies = {}, signal?: AbortSignal): Promise<number> {
  if (!(deps.review?.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    log('review 需要交互式终端（stdin 与 stdout 都必须是 TTY）');
    return 2;
  }
  return withInterrupt(signal, async (sig) => {
    const env = deps.env ?? process.env;
    let reviewer: string;
    try { reviewer = resolveReviewer(env, deps.review?.userInfo); }
    catch (error) { log(error instanceof Error ? error.message : String(error)); return 2; }
    const artifacts = new ArtifactStore(args.project);
    const code = await (deps.review?.runReview ?? runReview)({
      artifacts, reviewer, editor: createEditorHost(artifacts, env), open: createOpener(),
      view: args.view, module: args.modules?.[0], runId: args.runId, signal: sig,
    });
    sig.throwIfAborted();
    return code;
  });
}
