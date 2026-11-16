import { Approvals, ArtifactStore, BudgetTracker, ConfigSchema, readProfileFiles, type ProfileFile } from '@crosscheck/core';
import { discover, openApiPlugin, staticScanPlugin, synthesizeProfile } from '@crosscheck/discovery';
import type { CliArgs } from './args';
import { resolveModels, withInterrupt, type CommandDependencies } from './context';

export const DEFAULT_OPENAPI_FILES = [
  'openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json',
  'docs/openapi.yaml', 'docs/openapi.json', 'api/openapi.yaml',
];

/** 模型引用只是示例，需按实际可用的厂商与模型修改。 */
export const CONFIG_TEMPLATE = {
  models: {
    extractor: 'anthropic:claude-sonnet-4-6',
    planner: 'deepseek:deepseek-chat',
    executor: 'openai:gpt-5.4',
    reviewer: 'ollama:qwen2.5:7b',
  },
  budget: { perCase: { steps: 60, tokens: 400000, minutes: 10 } },
  requirementsDocs: [] as string[],
};

export async function initCommand(args: CliArgs, log: (s: string) => void, deps: CommandDependencies = {}, signal?: AbortSignal): Promise<number> {
  return withInterrupt(signal, async (sig) => {
    const artifacts = new ArtifactStore(args.project);
    const config = await artifacts.readYaml('config.yaml', ConfigSchema);
    sig.throwIfAborted();
    if (!config) {
      await artifacts.writeYaml('config.yaml', CONFIG_TEMPLATE);
      log('已写入 .crosscheck/config.yaml 模板：请填写四个模型角色、密钥环境变量与 requirementsDocs，然后重新运行 crosscheck init');
      return 2;
    }
    const scan = await discover({ projectRoot: args.project, plugins: [staticScanPlugin, openApiPlugin(args.openapi ?? DEFAULT_OPENAPI_FILES)], signal: sig });
    log(`发现事实 ${scan.facts.length} 条`);
    for (const d of scan.diagnostics) log(`诊断 [${d.plugin}]${d.file ? ` ${d.file}` : ''}：${d.message}`);

    const approvals = await Approvals.load(artifacts);
    const existing: Partial<Record<ProfileFile, unknown>> = {};
    for (const file of await readProfileFiles(artifacts)) {
      if (file.present && file.ok && approvals.state('profile', file.name, file.value) === 'approved') existing[file.name] = file.value;
    }
    sig.throwIfAborted();
    const models = resolveModels(config, 'extractor', deps, log);
    sig.throwIfAborted();
    const result = await synthesizeProfile({
      facts: scan.facts,
      existing,
      models,
      budget: () => new BudgetTracker(config.budget.perCase),
      signal: sig,
      resilience: deps.resilience,
    });
    sig.throwIfAborted();
    for (const [name, value] of Object.entries(result.generated)) {
      sig.throwIfAborted();
      await artifacts.writeYaml(`system/${name}`, value);
    }
    sig.throwIfAborted();
    for (const step of result.steps) {
      const files = step.files.join('、');
      if (step.status === 'generated') log(`已生成 ${files}`);
      else if (step.status === 'skipped') log(`跳过（已确认）${files}`);
      else log(`生成失败 ${files}：${step.detail ?? ''}`);
    }
    for (const issue of result.crossCheck) log(`交叉校验：${issue}`);
    log('画像草稿已写入 .crosscheck/system/，请运行 crosscheck review profile 审核');
    return result.interrupted || result.steps.some((s) => s.status === 'failed') ? 2 : 0;
  });
}
