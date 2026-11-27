import { Approvals, ArtifactStore, loadUserModelConfig, loadUserModelConfigSnapshot, resolveReviewer, UserModelConfigError, type UserModelConfig, type UserModelConfigSnapshot } from '@crosscheck/core';
import { atGenerateBoundary, builtinFactories, callWithFallback, createUsageObservationScope, readUsage, reportProgress, waitForRetry, withProgress, type TokenUsage } from '@crosscheck/models';
import { randomUUID } from 'node:crypto';
import { createEditorHost, createOpener, isSessionCancellation, loadHomeSummary, loadStatus, ReviewSession, runSession, type ChatMessage, type RegisterSessionSettle, type SessionPersistence, type SessionProgress, type SlashCommandResult } from '@crosscheck/tui';
import { createEvidenceRedactor } from '@crosscheck/tools';
import { APICallError, generateText } from 'ai';
import { appendFile, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, type CliArgs } from './args';
import { createCommandUsageObserver, createSessionTextNormalizer, loadModelContext, resolveModels, withInterrupt, withSessionUsageContext, type CommandDependencies } from './context';
import { formatUsageReport, formatUsageTotal } from './session-usage';
import { cliMain } from './main';
import cliPackage from '../package.json';
import { SessionStore, SessionStoreError, type SessionSnapshot } from './session-store';

export async function loadSessionInfo(home?: string) {
  try {
    const { models } = await loadUserModelConfig(home);
    return { version: cliPackage.version, configFile: '~/.crosscheck/config.yaml', models: { extractor: models.extractor, planner: models.planner, executor: models.executor, reviewer: models.reviewer } };
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

// 会话斜杠命令清单，供输入框 Tab 补全提示使用；顺序即补全列表顺序。
export const sessionSlashCommands = [
  { name: 'init', description: '扫描项目并生成项目笔记草稿' },
  { name: 'profile', description: '根据已确认笔记生成画像草稿' },
  { name: 'reqs', description: '提取需求条款草稿' },
  { name: 'plan', description: '生成用例草稿' },
  { name: 'review', description: '交互审核笔记、画像、条款、用例与结果' },
  { name: 'run', description: '执行已确认用例' },
  { name: 'report', description: '离线重建运行报告' },
  { name: 'impact', description: '只读分析当前磁盘相对 Git 基线的影响' },
  { name: 'status', description: '查看项目阶段、待审核任务与最近测试' },
  { name: 'usage', description: '查看启动项目或指定会话的模型用量' },
  { name: 'sessions', description: '列出启动项目的历史会话' },
  { name: 'resume', description: '按 ID 恢复历史会话' },
  { name: 'help', description: '显示命令帮助' },
  { name: 'clear', description: '清空对话历史并开始新会话' },
  { name: 'exit', description: '退出会话' },
];

type SessionState = { currentId: string; project: string; revision?: number; readonly?: boolean };

function restoredMessages(snapshot: SessionSnapshot): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const unfinished = new Set(snapshot.unfinishedBegins);
  for (const entry of snapshot.entries) {
    if (entry.kind === 'begin') {
      messages.push({ role: 'user', content: entry.input });
      if (unfinished.has(entry.revision)) messages.push({ role: 'assistant', content: '操作未完成（未重放）' });
    } else messages.push({ role: 'assistant', content: entry.output });
  }
  if (snapshot.diagnostics.length) {
    messages.push({ role: 'assistant', content: `${snapshot.readonly ? '会话记录损坏，只读' : '会话诊断'}：${snapshot.diagnostics.join('；')}` });
  }
  return messages;
}

type ChatConfigSnapshots = WeakMap<AbortSignal, UserModelConfigSnapshot>;

function createPersistence(state: SessionState, store: SessionStore, deps: CommandDependencies, chatConfigs: ChatConfigSnapshots): SessionPersistence {
  return {
    get isReadonly() { return state.readonly === true; },
    async begin(operation, text, signal, warn) {
      if (state.readonly) throw new Error('当前会话只读，请使用 /usage、/sessions、/resume、/clear 或 /exit');
      const { currentId, revision = 0 } = state;
      const snapshot = await loadUserModelConfigSnapshot(deps.userConfigHome);
      // 归档和模型调用共用本轮配置，读取失败也不在同一轮重读。
      if (operation === 'chat') chatConfigs.set(signal, snapshot);
      const normalize = createSessionTextNormalizer(snapshot.apiKeys);
      const input = normalize(text);
      const normalizeError = (error: unknown): string => {
        // 仅识别宿主定义的错误来源，不用消息文本猜测诊断是否可信。
        if (error instanceof UserModelConfigError) return error.diagnostic;
        return normalize(error instanceof Error ? error.message : String(error));
      };
      const normalizeStoreError = (error: unknown): string => {
        if (error instanceof SessionStoreError && error.code === 'conflict') return '会话版本冲突，请重新加载';
        return normalize(error instanceof Error ? error.message : String(error));
      };
      const started = await store.append(currentId, revision, { kind: 'begin', operation, input }, warn)
        .catch(error => { throw new Error(normalizeStoreError(error)); });
      state.revision = started.revision;
      return { input, normalize, normalizeError, normalizeStoreError, finish: async (result) => {
        const ended = await store.append(currentId, started.revision, { kind: 'end', begin: started.revision, ...result }, warn);
        state.revision = ended.revision;
      } };
    },
  };
}
const sessionUuid = /^(?:[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const modelCommands = new Set(['init', 'profile', 'reqs', 'plan', 'run']);
const projectCommands = new Set([...modelCommands, 'report', 'impact']);

function sessionUsage(session: SessionState, deps: CommandDependencies) {
  // 未落盘的缺口无法从账本重建；在本进程内按启动项目和会话保留提示。
  const missing = new Set<string>();
  const projectPath = (project: string) => realpath(project).catch(() => path.resolve(project));
  return {
    markMissing: async (project: string, sessionId: string) => {
      if (project === session.project || await projectPath(project) === await projectPath(session.project)) missing.add(sessionId);
    },
    read: async (sessionId?: string) => {
      const report = await readUsage({ project: session.project, home: deps.userConfigHome, sessionId });
      if (sessionId === undefined ? missing.size > 0 : missing.has(sessionId)) {
        report.incomplete = true;
        report.diagnostics.push('存在未落盘的用量记录，无法计入已知部分');
      }
      return report;
    },
  };
}

export function createSlashDispatcher(deps: CommandDependencies, session?: SessionState) {
  return createDispatcher(deps, session, session && sessionUsage(session, deps));
}

function createDispatcher(deps: CommandDependencies, session?: SessionState, usage?: ReturnType<typeof sessionUsage>, store = session && new SessionStore(session.project, deps.userConfigHome)) {
  // 命令日志与模型/工具执行提示都实时推给会话界面，最终输出仍随结果返回。
  return (tokens: string[], signal: AbortSignal, onProgress?: SessionProgress, registerSettle?: RegisterSessionSettle): Promise<SlashCommandResult> =>
    withProgress(onProgress, () => dispatch(tokens, signal, onProgress, registerSettle));
  async function dispatch(tokens: string[], signal: AbortSignal, onProgress?: SessionProgress, registerSettle?: RegisterSessionSettle): Promise<SlashCommandResult> {
    if (!tokens.length || !tokens[0]) return { kind: 'log', code: 2, lines: ['斜杠命令不能为空'] };
    if (tokens[0] === 'exit') return tokens.length === 1 ? { kind: 'exit' } : { kind: 'log', code: 2, lines: ['exit 不接受参数'] };
    if (tokens[0] === 'clear') return tokens.length === 1 ? { kind: 'clear' } : { kind: 'log', code: 2, lines: ['clear 不接受参数'] };
    if (tokens[0] === 'sessions' || tokens[0] === 'resume') {
      const resume = tokens[0] === 'resume';
      const usageLine = resume ? '用法：/resume <UUID>' : '用法：/sessions';
      const id = tokens[1];
      if (tokens.length > (resume ? 2 : 1) || (id !== undefined && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id))) {
        return { kind: 'log', code: 2, lines: [usageLine] };
      }
      if (!session || !store) return { kind: 'log', code: 2, lines: ['历史会话仅在交互会话中可用'] };
      signal.throwIfAborted();
      if (id !== undefined) {
        const snapshot = await store.load(id);
        signal.throwIfAborted();
        if (!snapshot) return { kind: 'log', code: 3, lines: ['未找到该会话，请使用 /sessions 查看可用 ID'] };
        if (snapshot.revision === 0) return { kind: 'log', code: 3, lines: ['无法恢复：会话没有有效记录', ...snapshot.diagnostics] };
        return { kind: 'resume', messages: restoredMessages(snapshot), history: snapshot.history, activate: () => {
          Object.assign(session, { currentId: snapshot.id, revision: snapshot.revision, readonly: snapshot.readonly });
        } };
      }
      const items = await store.list();
      signal.throwIfAborted();
      const lines = resume ? [usageLine] : ['启动项目的历史会话：'];
      if (!items.length) lines.push('暂无历史会话');
      for (const item of items) lines.push(`${item.id} ${item.updatedAt ?? '时间未知'}${item.diagnostics.length ? `（${item.readonly ? '只读' : '诊断'}：${item.diagnostics.join('；')}）` : ''}${item.preview ? ` ${item.preview}` : ''}`);
      return { kind: 'log', code: 0, lines };
    }
    if (tokens[0] === 'usage') {
      if (!session || !usage) return { kind: 'log', code: 2, lines: ['用量查询仅在交互会话中可用'] };
      const [ , flag, id ] = tokens;
      if (tokens.length > 1 && (flag !== '--session' || tokens.length > 3 || (tokens.length === 3 && !sessionUuid.test(id ?? '')))) {
        return { kind: 'log', code: 2, lines: ['用法：/usage [--session [UUID]]'] };
      }
      const sessionId = flag === '--session' ? (id?.toLowerCase() ?? session.currentId) : undefined;
      signal.throwIfAborted();
      const report = await usage.read(sessionId);
      signal.throwIfAborted();
      return { kind: 'log', code: 0, ...formatUsageReport(session.project, sessionId, report) };
    }
    if (tokens[0] === 'status') {
      if (tokens.length !== 1 && !(tokens.length === 3 && tokens[1] === '--project' && tokens[2] && !tokens[2].startsWith('--'))) {
        return { kind: 'log', code: 2, lines: ['用法：/status [--project <目录>]'] };
      }
      try {
        signal.throwIfAborted();
        const artifacts = new ArtifactStore(tokens[2] ?? session?.project ?? process.cwd());
        const status = await loadStatus({ artifacts, approvals: await Approvals.load(artifacts) });
        signal.throwIfAborted();
        const stages = { profile: '画像准备与审核', clauses: '需求条款准备与审核', cases: '测试用例准备与审核', run: '准备或执行测试', results: '查看和审核测试结果' };
        const lines = [`当前阶段（根据工件推断）：${stages[status.stage]}`, '待审核任务：'];
        for (const [label, count] of [['画像', status.profile], ['条款', status.clauses], ['用例', status.cases]] as const) {
          lines.push(`  ${label}：${count.pending ?? '未知'} / ${count.total ?? '未知'}`);
          for (const issue of count.issues) lines.push(`    ${issue.location}：${issue.message}`);
        }
        const run = status.latestRun;
        if (run.state === 'ready') {
          lines.push(`  最新运行待裁决预期：${run.pendingDispositions}`);
          lines.push(`上一次测试：${run.runId}，开始时间 ${run.start}，运行状态 ${run.status}，结果 ${run.resultStatus}`);
          lines.push(`  用例结果：${Object.entries(run.counts).map(([key, value]) => `${key} ${value}`).join('，')}`);
        } else {
          lines.push('  最新运行待裁决预期：未知');
          const label = run.state === 'missing' ? '缺失' : run.state === 'incomplete' ? '未完成' : '损坏';
          lines.push(`上一次测试：${label}${run.runId ? `（${run.runId}）` : ''}${run.start ? `，开始时间 ${run.start}` : ''}${run.status ? `，运行状态 ${run.status}` : ''}${run.error ? `：${run.error}` : ''}`);
        }
        return { kind: 'log', code: 0, lines };
      } catch (error) {
        if (signal.aborted) throw error;
        return { kind: 'log', code: 3, lines: [`状态读取失败：${error instanceof Error ? error.message : String(error)}`] };
      }
    }
    const projectIndex = tokens.indexOf('--project');
    if (tokens[0] === 'review') {
      try {
        const args = parseArgs(tokens);
        if (session && projectIndex < 0) args.project = session.project;
        return { kind: 'review', args };
      } catch (error) { return { kind: 'log', code: 2, lines: [error instanceof Error ? error.message : String(error)] }; }
    }
    const lines: string[] = [];
    const argv = session && projectCommands.has(tokens[0]!) && projectIndex < 0 ? [...tokens, '--project', session.project] : tokens;
    const sessionId = session?.currentId;
    let missing = false;
    const dependencies = sessionId === undefined ? deps : withSessionUsageContext(deps, sessionId, line => {
      missing = true;
      if (onProgress) onProgress(line, 'warning');
      else lines.push(line);
    });
    const scope = registerSettle && modelCommands.has(tokens[0]!) ? createUsageObservationScope() : undefined;
    const markMissing = async () => {
      if (missing && session && sessionId !== undefined) {
        await usage?.markMissing(projectIndex < 0 ? session.project : tokens[projectIndex + 1]!, sessionId);
      }
    };
    if (scope) registerSettle?.(async () => { await scope.flush(); await markMissing(); });
    try {
      const fixedDiagnosticLineIndices: number[] = [];
      const result: Extract<SlashCommandResult, { kind: 'log' }> = { kind: 'log', code: 0, lines };
      result.code = await cliMain(argv, { dependencies: scope ? { ...dependencies, usageObservationScope: scope } : dependencies, signal,
        log: (line) => { lines.push(line); onProgress?.(line); }, onCancelled: () => { result.cancelled = true; },
        onFixedDiagnostic: () => { fixedDiagnosticLineIndices.push(lines.length - 1); } });
      if (fixedDiagnosticLineIndices.length) result.fixedDiagnosticLineIndices = fixedDiagnosticLineIndices;
      return result;
    } finally { if (!scope) await markMissing(); }
  }
}

export function chatReply(project: string, history: ChatMessage[], text: string, deps: CommandDependencies, signal: AbortSignal): Promise<string> {
  return generateChatReply(project, history, text, deps, signal, false);
}

async function generateChatReply(project: string, history: ChatMessage[], text: string, deps: CommandDependencies, signal: AbortSignal, normalizeInHost: boolean, configSnapshot?: UserModelConfig): Promise<string> {
  const artifacts = new ArtifactStore(project);
  reportProgress('读取项目摘要与模型配置');
  const context = await loadModelContext(artifacts, deps, configSnapshot);
  const { config, redactor } = context;
  signal.throwIfAborted();
  // 摘要只读确认记录，不需要解析操作者身份。
  const summary = await loadHomeSummary({ artifacts, approvals: await Approvals.load(artifacts) });
  signal.throwIfAborted();
  const previous = history.slice(-20);
  // 同时保护仍在内存和已恢复的历史；拒绝调用，不改写任一份已规范化的消息。
  if (normalizeInHost && previous.some(message => redactor.containsKnownSecret(message.content))) {
    throw new Error('聊天历史命中当前配置密钥，未调用模型。原历史未修改；请使用 /clear 开始新会话。');
  }
  const recent: ChatMessage[] = [...previous, { role: 'user', content: text }];
  // 持久化宿主已规范化输入和历史；独立调用没有该边界，需要就地处理。
  const messages = normalizeInHost ? recent : recent.map(message => ({ ...message, content: redactor.displayText(message.content) }));
  const requestFetch: typeof fetch = async (input, init) => {
    try {
      const request = new Request(input, init);
      const url = new URL(request.url);
      // 查询参数不参与诊断，全部省略以防未知凭据泄露。
      url.search = '';
      url.hash = '';
      const headers = redactor.headers(Object.fromEntries(request.headers.entries()));
      const contentType = request.headers.get('content-type') ?? '';
      const rawBody = request.body ? await request.clone().text() : '';
      const body = rawBody ? redactor.body(rawBody, contentType) : undefined;
      const record = { time: new Date().toISOString(), method: request.method, url: redactor.url(url.toString()), headers, body };
      const directory = path.join(deps.userConfigHome ?? os.homedir(), '.crosscheck');
      await mkdir(directory, { recursive: true });
      await appendFile(path.join(directory, 'chat-requests.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch { /* 调试日志不能影响实际请求。 */ }
    return globalThis.fetch(input, init);
  };
  const factories = context.deps.modelOptions.factories;
  const modelDeps = { ...context.deps, modelOptions: { ...context.deps.modelOptions, factories: {
    anthropic: (settings: Parameters<typeof builtinFactories.anthropic>[0]) => (factories?.anthropic ?? builtinFactories.anthropic)({ ...settings, fetch: requestFetch }),
    openai: (settings: Parameters<typeof builtinFactories.openai>[0]) => (factories?.openai ?? builtinFactories.openai)({ ...settings, fetch: requestFetch }),
  } } };
  const models = resolveModels(config, 'planner', modelDeps, () => {});
  const observer = createCommandUsageObserver(project, 'chat', 'planner', config.pricing, deps, line => console.warn(line));
  const scope = deps.usageObservationScope ?? createUsageObservationScope();
  try {
    const result = await callWithFallback(models, async (model, ref) => {
      let started = false;
      let receipt: TokenUsage | null = null;
      let response: Awaited<ReturnType<typeof generateText>>;
      try {
        reportProgress(`请求模型 ${ref} 生成回复`);
        response = await generateText({ model: atGenerateBoundary(model, () => { started = true; }, usage => { receipt = usage; }), maxRetries: 0, system: `你是只读助手。仅根据项目摘要回答，不可执行写入或确认操作；请引导用户使用斜杠命令或 /review 自行操作。项目摘要：${JSON.stringify(summary)}`, messages, abortSignal: signal });
      } catch (error) {
        if (started) scope.enqueue(observer, { ref, purpose: 'request', status: isSessionCancellation(signal, error) ? 'cancelled' : 'error', usage: receipt });
        try {
          const provider = config.providers[ref.split(':')[0]!];
          const endpoint = provider ? new URL(provider.baseURL).origin : undefined;
          const apiError = APICallError.isInstance(error) ? error : undefined;
          const requestId = apiError?.responseHeaders?.['x-request-id'];
          const record = { time: new Date().toISOString(), stage: 'model-request', ref: redactor.text(ref), endpoint: endpoint ? redactor.url(endpoint).replace(/\/$/, '') : undefined, statusCode: apiError?.statusCode, requestId: requestId && /^[\w.-]{1,128}$/.test(requestId) ? redactor.text(requestId) : undefined };
          const directory = path.join(deps.userConfigHome ?? os.homedir(), '.crosscheck');
          await mkdir(directory, { recursive: true });
          await appendFile(path.join(directory, 'chat-errors.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
        } catch { /* 日志故障不能遮盖模型调用错误。 */ }
        throw error;
      }
      if (started) scope.enqueue(observer, { ref, purpose: 'request', status: 'success', usage: receipt });
      return response.text;
    }, { ...deps.resilience, signal, ...(normalizeInHost && {
      // 只在等待重试时传播取消原因；已失败的请求和共享重试逻辑的其他调用方保持原语义。
      sleep: async (ms, retrySignal) => {
        await (deps.resilience?.sleep ?? waitForRetry)(ms, retrySignal);
        retrySignal?.throwIfAborted();
      },
    }) });
    return normalizeInHost ? result.value : redactor.displayText(result.value);
  } catch (error) {
    if (normalizeInHost) throw error;
    throw new Error(redactor.displayText(error instanceof Error ? error.message : '模型调用失败'));
  }
  finally { if (!deps.usageObservationScope) await scope.flush(); }
}

export async function sessionCommand(args: CliArgs, log: (s: string) => void, deps: CommandDependencies, signal?: AbortSignal): Promise<number> {
  if (!(deps.session?.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    log('交互会话需要交互式终端（stdin 与 stdout 都必须是 TTY）');
    return 2;
  }
  const state: SessionState = { currentId: randomUUID(), project: await realpath(args.project), revision: 0 };
  const store = new SessionStore(state.project, deps.userConfigHome);
  const usage = sessionUsage(state, deps);
  const chatConfigs: ChatConfigSnapshots = new WeakMap();
  return withInterrupt(signal, async (sig) => runSession({
    info: await loadSessionInfo(deps.userConfigHome),
    slashCommands: sessionSlashCommands,
    signal: sig,
    tokenize: tokenizeCommand,
    runSlashCommand: createDispatcher(deps, state, usage, store),
    persistence: createPersistence(state, store, deps, chatConfigs),
    resetSession: () => { Object.assign(state, { currentId: randomUUID(), revision: 0, readonly: false }); },
    loadSessionUsage: async () => {
      const id = state.currentId;
      const report = await usage.read(id);
      return `会话 ID：${id}\n会话用量：${formatUsageTotal(report.total, report.incomplete)}`;
    },
    resolveReview: async (reviewArgs, operationSignal) => {
      operationSignal.throwIfAborted();
      const env = deps.env ?? process.env;
      const reviewer = resolveReviewer(env, deps.review?.userInfo);
      const artifacts = new ArtifactStore(reviewArgs.project);
      const session = await ReviewSession.open(artifacts, reviewer);
      operationSignal.throwIfAborted();
      return { session, editor: createEditorHost(artifacts, env), open: createOpener() };
    },
    chatReply: async (history, text, operationSignal, onProgress, registerSettle) => {
      const id = state.currentId;
      let missing = false;
      const chatDeps = withSessionUsageContext(deps, id, line => {
        missing = true;
        if (onProgress) onProgress(line, 'warning');
        else console.warn(line);
      });
      const scope = registerSettle ? createUsageObservationScope() : undefined;
      const markMissing = async () => { if (missing) await usage.markMissing(state.project, id); };
      if (scope) registerSettle?.(async () => { await scope.flush(); await markMissing(); });
      const configSnapshot = chatConfigs.get(operationSignal);
      chatConfigs.delete(operationSignal);
      try {
        if (configSnapshot && 'error' in configSnapshot) throw configSnapshot.error;
        return await withProgress(onProgress, () => generateChatReply(state.project, history, text, { ...chatDeps, usageObservationScope: scope }, operationSignal, true, configSnapshot?.config));
      } finally { if (!scope) await markMissing(); }
    },
    // SGR 鼠标上报：会话界面据此响应滚轮翻看历史。
    mouseTracking: (enabled) => { process.stdout.write(enabled ? '\u001b[?1000h\u001b[?1006h' : '\u001b[?1000l\u001b[?1006l'); },
  }));
}
