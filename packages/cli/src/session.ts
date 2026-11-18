import { Approvals, ArtifactStore, loadUserModelConfig, resolveReviewer } from '@crosscheck/core';
import { callWithFallback } from '@crosscheck/models';
import { createEditorHost, createOpener, loadHomeSummary, ReviewSession, runSession, type ChatMessage, type SlashCommandResult } from '@crosscheck/tui';
import { generateText } from 'ai';
import { parseArgs, type CliArgs } from './args';
import { loadModelContext, resolveModels, withInterrupt, type CommandDependencies } from './context';
import { cliMain } from './main';
import cliPackage from '../package.json';

export async function loadSessionInfo(home?: string) {
  try {
    const { models } = await loadUserModelConfig(home);
    return { version: cliPackage.version, models: { extractor: models.extractor, planner: models.planner, executor: models.executor, reviewer: models.reviewer } };
  } catch {
    return { version: cliPackage.version, models: undefined };
  }
}

export function tokenizeCommand(text: string): string[] {
  const tokens: string[] = [];
  let token = '', quote = '', started = false;
  for (const char of text) {
    if (quote) { if (char === quote) quote = ''; else token += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(token); token = ''; started = false; } }
    else { token += char; started = true; }
  }
  if (quote) throw new Error('引号未闭合');
  if (started) tokens.push(token);
  return tokens;
}

export function createSlashDispatcher(deps: CommandDependencies) {
  return async (tokens: string[], signal: AbortSignal): Promise<SlashCommandResult> => {
    if (!tokens.length || !tokens[0]) return { kind: 'log', code: 2, lines: ['斜杠命令不能为空'] };
    if (tokens[0] === 'exit') return tokens.length === 1 ? { kind: 'exit' } : { kind: 'log', code: 2, lines: ['exit 不接受参数'] };
    if (tokens[0] === 'review') {
      try { return { kind: 'review', args: parseArgs(tokens) }; }
      catch (error) { return { kind: 'log', code: 2, lines: [error instanceof Error ? error.message : String(error)] }; }
    }
    const lines: string[] = [];
    const code = await cliMain(tokens, { dependencies: deps, signal, log: (line) => lines.push(line) });
    return { kind: 'log', code, lines };
  };
}

export async function chatReply(project: string, history: ChatMessage[], text: string, deps: CommandDependencies, signal: AbortSignal): Promise<string> {
  const artifacts = new ArtifactStore(project);
  const context = await loadModelContext(artifacts, deps);
  const { config, redactor } = context;
  signal.throwIfAborted();
  // 摘要只读确认记录，不需要解析操作者身份。
  const summary = await loadHomeSummary({ artifacts, approvals: await Approvals.load(artifacts) });
  signal.throwIfAborted();
  const models = resolveModels(config, 'planner', context.deps, () => {});
  try {
  const result = await callWithFallback(models, async (model) => {
    const response = await generateText({ model, maxRetries: 0, system: `你是只读助手。仅根据项目摘要回答，不可执行写入或确认操作；请引导用户使用斜杠命令或 /review 自行操作。项目摘要：${JSON.stringify(summary)}`, messages: [...history.slice(-20), { role: 'user', content: text }], abortSignal: signal });
    return response.text;
  }, { ...deps.resilience, signal });
  return redactor.text(result.value);
  } catch (error) { throw new Error(redactor.text(error instanceof Error ? error.message : '模型调用失败')); }
}

export async function sessionCommand(args: CliArgs, log: (s: string) => void, deps: CommandDependencies, signal?: AbortSignal): Promise<number> {
  if (!(deps.session?.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    log('交互会话需要交互式终端（stdin 与 stdout 都必须是 TTY）');
    return 2;
  }
  return withInterrupt(signal, async (sig) => runSession({
    info: await loadSessionInfo(deps.userConfigHome),
    signal: sig,
    tokenize: tokenizeCommand,
    runSlashCommand: createSlashDispatcher(deps),
    resolveReview: async (reviewArgs, operationSignal) => {
      operationSignal.throwIfAborted();
      const env = deps.env ?? process.env;
      const reviewer = resolveReviewer(env, deps.review?.userInfo);
      const artifacts = new ArtifactStore(reviewArgs.project);
      const session = await ReviewSession.open(artifacts, reviewer);
      operationSignal.throwIfAborted();
      return { session, editor: createEditorHost(artifacts, env), open: createOpener() };
    },
    chatReply: (history, text, operationSignal) => chatReply(args.project, history, text, deps, operationSignal),
  }));
}
