import { ArtifactError, GateError, exitCodeFor, loadUserModelConfig, loadVerifiedRunInputs, type ArtifactStore, type RunResult, type RunInputOptions, type UserModelConfig } from '@crosscheck/core';
import { ModelConfigError, resolveRole, type ResolveOptions, type ResilienceOptions } from '@crosscheck/models';
import { type BrowserHostOptions, type HttpTransport, type PgConnection } from '@crosscheck/tools';
import { RunStore } from './store/run-store';
import { executeCase } from './run-case';
import { executionFingerprint, findResume, snapshot, verifySnapshot } from './resume';
import { runRedactor } from './redactor';
import { preflight } from './preflight';

export interface RunSuiteOptions extends RunInputOptions {
  artifacts: ArtifactStore;
  resume?: string | true;
  signal?: AbortSignal;
  modelOptions?: ResolveOptions;
  resilience?: ResilienceOptions;
  transport?: HttpTransport;
  launchBrowser?: BrowserHostOptions['launch'];
  env?: Record<string, string | undefined>;
  createConnection?: (url: string) => PgConnection;
  userConfigHome?: string;
}
export interface SuiteOutcome { exitCode: 0 | 1 | 2 | 3; interrupted: boolean; result?: RunResult; error?: string }

/** CLI 入口：不接受调用方提供的 Verified 对象，任何业务副作用前实际加载审批链。 */
export async function runSuite(options: RunSuiteOptions): Promise<SuiteOutcome> {
  let input: Awaited<ReturnType<typeof loadVerifiedRunInputs>>;
  let userConfig: UserModelConfig;
  try { userConfig = await loadUserModelConfig(options.userConfigHome); }
  catch (error) { return { exitCode: 2, interrupted: !!options.signal?.aborted, error: error instanceof Error ? error.message : '全局配置读取失败' }; }
  const apiKeys = Object.fromEntries(Object.entries(userConfig.providers).map(([name, provider]) => [name, provider.apiKey]));
  const modelOptions = { ...options.modelOptions, apiKeys };
  try { input = await loadVerifiedRunInputs(options.artifacts, { environment: options.environment, modules: options.modules, caseIds: options.caseIds }, userConfig); }
  catch (error) { return { exitCode: error instanceof GateError || error instanceof ArtifactError && !error.cause ? 2 : 3, interrupted: !!options.signal?.aborted, error: error instanceof GateError ? error.message : '运行输入读取或审批校验失败' }; }
  // 全部用例在结构检查即拒绝时，不解析任何模型、认证或服务秘密。
  const runnable = input.cases.some(tc => !preflight(input, tc));
  const sourceEnv = runnable ? options.env ?? options.modelOptions?.env ?? process.env : {};
  if (runnable) {
    try {
      const resolveOptions = { ...modelOptions, env: sourceEnv, onWarning: () => {} };
      resolveRole(input.config, 'executor', resolveOptions);
      resolveRole(input.config, 'reviewer', resolveOptions);
    } catch (error) {
      if (error instanceof ModelConfigError) return { exitCode: 2, interrupted: !!options.signal?.aborted, error: runRedactor(input, sourceEnv, Object.values(apiKeys).filter((key): key is string => !!key)).text(error.message) };
      return { exitCode: 3, interrupted: !!options.signal?.aborted, error: '模型初始化失败' };
    }
  }
  const fingerprint = executionFingerprint(input, options.resilience);
  let run: RunStore;
  try {
    if (options.resume) run = await findResume(options.artifacts, options.resume, fingerprint);
    else {
      const redactor = runRedactor(input, sourceEnv, Object.values(apiKeys).filter((key): key is string => !!key));
      // 按批准结构投影 URL 字段；自然语言不猜测为 URL。
      const projected = structuredClone(input);
      for (const environment of Object.values(projected.profile['environments.yaml'].environments)) {
        environment.baseURL = redactor.url(environment.baseURL);
        environment.healthcheck = redactor.url(environment.healthcheck);
      }
      for (const item of [...Object.values(projected.profile['api-catalog.yaml'].operations), ...Object.values(projected.profile['pages.yaml'].pages)]) item.path = redactor.url(item.path);
      for (const provider of Object.values(projected.config.providers)) if (provider.baseURL) provider.baseURL = redactor.url(provider.baseURL);
      for (const actor of Object.values(projected.profile['auth.yaml'].actors)) if (actor.kind === 'form' || actor.kind === 'replay') for (const action of actor.actions) if (action.kind === 'goto') action.url = redactor.url(action.url);
      const display = redactor.value(projected);
      run = await RunStore.create(options.artifacts, { fingerprint, environment: input.environment, selectedCaseIds: input.cases.map(tc => tc.id) }, snapshot(input, fingerprint, display));
    }
  } catch { return { exitCode: options.resume ? 2 : 3, interrupted: !!options.signal?.aborted, error: options.resume ? '没有兼容运行或恢复指纹不一致' : '创建运行存储失败' }; }
  try {
    return await run.withLock(async () => {
      // 持锁后读取最新清单，不能用锁外旧快照覆盖另一进程已提交状态。
      run = await RunStore.load(options.artifacts, run.manifest.runId);
      await verifySnapshot(options.artifacts, run, input, fingerprint);
      await run.updateStatus('running');
      const completed = new Set((await run.listCaseResults()).map(c => c.caseId));
      const env = { ...sourceEnv };
      let hostError: string | undefined;
      for (const tc of input.cases) {
        if (completed.has(tc.id)) continue;
        const deferred = !!options.signal?.aborted || !!hostError;
        const executed = await executeCase(options.artifacts, run, input, tc, { ...options, modelOptions, env }, deferred);
        hostError ??= executed.hostError;
      }
      const interrupted = !!options.signal?.aborted;
      await run.updateStatus(interrupted || hostError ? 'aborted' : 'completed');
      const result = await run.rebuildSummary();
      return { exitCode: hostError ? 3 : interrupted ? 2 : exitCodeFor(result.cases.map(c => c.status)), interrupted, result, ...(hostError ? { error: hostError } : {}) };
    });
  } catch (error) {
    return { exitCode: error instanceof ArtifactError && error.message.includes('指纹') ? 2 : 3, interrupted: !!options.signal?.aborted, error: error instanceof ArtifactError && error.message.includes('指纹') ? error.message : '宿主运行存储、锁或资源清理失败' };
  }
}

/** 单用例入口仍走完整真实审批与快照流程；不允许伪造 Verified 类型绕过。 */
export async function runCase(options: Omit<RunSuiteOptions, 'caseIds'> & { caseId: string }): Promise<SuiteOutcome> {
  return runSuite({ ...options, caseIds: [options.caseId] });
}
