import { Approvals, ArtifactStore, BudgetTracker, ProjectConfigSchema, readProfileFiles, type ProfileFile } from '@crosscheck/core';
import { discover, openApiPlugin, staticScanPlugin, synthesizeProfile } from '@crosscheck/discovery';
import type { CliArgs } from './args';
import { loadModelContext, resolveModels, withInterrupt, type CommandDependencies } from './context';

export const DEFAULT_OPENAPI_FILES = [
  'openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json',
  'docs/openapi.yaml', 'docs/openapi.json', 'api/openapi.yaml',
];

/** 模型引用只是示例，需按实际可用的厂商与模型修改。 */
export const CONFIG_TEMPLATE = {
  budget: { perCase: { steps: 60, tokens: 400000, minutes: 10 } },
  requirementsDocs: [] as string[],
};

export async function initCommand(args: CliArgs, log: (s: string) => void, deps: CommandDependencies = {}, signal?: AbortSignal): Promise<number> {
  return withInterrupt(signal, async (sig) => {
    const artifacts = new ArtifactStore(args.project);
    const projectConfig = await artifacts.readYaml('config.yaml', ProjectConfigSchema);
    sig.throwIfAborted();
    if (!projectConfig) {
      await artifacts.writeYaml('config.yaml', CONFIG_TEMPLATE);
      log('已写入 .crosscheck/config.yaml 模板：请配置 requirementsDocs 和全局 ~/.crosscheck/config.yaml，然后重新运行 crosscheck init');
      return 2;
    }
    const context = await loadModelContext(artifacts, deps);
    const { config, redactor } = context;
    const scan = await discover({ projectRoot: args.project, plugins: [staticScanPlugin, openApiPlugin(args.openapi ?? DEFAULT_OPENAPI_FILES)], signal: sig });
    log(`发现事实 ${scan.facts.length} 条`);
    for (const d of scan.diagnostics) log(redactor.text(`诊断 [${d.plugin}]${d.file ? ` ${d.file}` : ''}：${d.message}`));

    const approvals = await Approvals.load(artifacts);
    const existing: Partial<Record<ProfileFile, unknown>> = {};
    for (const file of await readProfileFiles(artifacts)) {
      if (file.present && file.ok && approvals.state('profile', file.name, file.value) === 'approved') existing[file.name] = file.value;
    }
    sig.throwIfAborted();
    const models = resolveModels(config, 'extractor', context.deps, (line) => log(redactor.text(line)));
    sig.throwIfAborted();
    const result = await synthesizeProfile({
      facts: scan.facts,
      existing,
      models,
      budget: () => new BudgetTracker(config.budget.perCase),
      signal: sig,
      resilience: deps.resilience,
    }).catch((error: unknown) => { throw new Error(redactor.text(error instanceof Error ? error.message : '模型调用失败')); });
    sig.throwIfAborted();
    for (const [name, value] of Object.entries(result.generated)) {
      sig.throwIfAborted();
      await artifacts.writeYaml(`system/${name}`, redactor.value(value));
    }
    sig.throwIfAborted();
    for (const step of result.steps) {
      const files = step.files.join('、');
      if (step.status === 'generated') log(`已生成 ${files}`);
      else if (step.status === 'skipped') log(`跳过（已确认）${files}`);
      else log(redactor.text(`生成失败 ${files}：${step.detail ?? ''}`));
    }
    for (const issue of result.crossCheck) log(redactor.text(`交叉校验：${issue}`));
    log('画像草稿已写入 .crosscheck/system/，请运行 crosscheck review profile 审核');
    return result.interrupted || result.steps.some((s) => s.status === 'failed') ? 2 : 0;
  });
}
