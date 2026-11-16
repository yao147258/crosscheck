import { CaseIdSchema, ProfileNameSchema } from '@crosscheck/core';

export type Command = 'init' | 'reqs' | 'plan' | 'review' | 'run' | 'report';
export type ReviewView = 'profile' | 'clauses' | 'cases' | 'results';
export interface CliArgs {
  command: Command | 'help';
  project: string;
  environment?: string;
  modules?: string[];
  caseIds?: string[];
  resume?: string | true;
  runId?: string;
  open: boolean;
  view?: ReviewView;
  openapi?: string[];
}

export const HELP = `Crosscheck 本地验收 CLI（Node >=22.12）
  crosscheck init [--openapi <文件>]... [--project <目录>]
  crosscheck reqs --module <id> [--project <目录>]
  crosscheck plan --module <id> [--project <目录>]
  crosscheck review [profile|clauses|cases|results] [--module <id>] [--run <runId>] [--project <目录>]
  crosscheck run [--module <id>]... [--case <id>]... [--resume [runId]] [--project <目录>] [--environment <名称>] [--open]
  crosscheck report <runId> [--project <目录>] [--open]
  crosscheck --help
init/reqs/plan 只写草稿，不自动确认；确认只能在 review 中由人完成。
review 需要交互式终端；编辑使用 VISUAL 或 EDITOR 指定的编辑器，确认人取 CROSSCHECK_REVIEWER 或系统用户名。
run 中重复 module/case 各自为集合，两类筛选取交集。未知/空选择不视为通过。
report 仅读取历史快照与真实证据，离线重建 JSON/JUnit/HTML。
浏览器工具暂缓。只有 --open 会打开系统默认浏览器。
退出码：0 成功/全 PASS；1 含 FAIL（疑似 bug 待人工）；2 阻断/不确定/空/中断/参数错误/门禁未满足；3 宿主错误优先。`;

const COMMANDS: readonly Command[] = ['init', 'reqs', 'plan', 'review', 'run', 'report'];
const FLAGS: Record<Command, readonly string[]> = {
  init: ['--openapi', '--project'],
  reqs: ['--module', '--project'],
  plan: ['--module', '--project'],
  review: ['--module', '--run', '--project'],
  run: ['--module', '--case', '--resume', '--project', '--environment', '--open'],
  report: ['--project', '--open'],
};
const REPEATABLE: Record<Command, readonly string[]> = {
  init: ['--openapi'], run: ['--module', '--case'], reqs: [], plan: [], review: [], report: [],
};
const VIEWS: readonly ReviewView[] = ['profile', 'clauses', 'cases', 'results'];
const RUN_ID = /^\d{8}T\d{9}Z-[a-f0-9]{32}$/;

export function parseArgs(args: string[]): CliArgs {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) return { command: 'help', project: process.cwd(), open: false };
  const command = args[0] as Command;
  if (!COMMANDS.includes(command)) throw new Error('请选择 init、reqs、plan、review、run 或 report；使用 --help 查看参数');
  const result: CliArgs = { command, project: process.cwd(), open: false };
  const seen = new Set<string>();
  let index = 1;
  if (command === 'report') {
    result.runId = args[index++];
    if (!result.runId || !RUN_ID.test(result.runId)) throw new Error('report 需要合法的 runId');
  }
  if (command === 'review' && args[index] !== undefined && !args[index]!.startsWith('--')) {
    const view = args[index++] as ReviewView;
    if (!VIEWS.includes(view)) throw new Error('review 视图只能是 profile、clauses、cases 或 results');
    result.view = view;
  }
  while (index < args.length) {
    const flag = args[index++]!;
    if (!FLAGS[command].includes(flag)) throw new Error(`未知或不适用于 ${command} 的参数：${flag}`);
    if (seen.has(flag) && !REPEATABLE[command].includes(flag)) throw new Error(`单值参数不能重复：${flag}`);
    seen.add(flag);
    if (flag === '--open') { result.open = true; continue; }
    if (flag === '--resume' && (!args[index] || args[index]!.startsWith('--'))) { result.resume = true; continue; }
    const value = args[index++];
    if (!value || value.startsWith('--')) throw new Error(`参数缺少非空值：${flag}`);
    switch (flag) {
      case '--module': {
        const pattern = command === 'reqs' || command === 'plan' ? /^[A-Za-z0-9_]+$/ : /^[A-Za-z0-9_-]+$/;
        if (!pattern.test(value)) throw new Error(`模块名不合法：${value}`);
        (result.modules ??= []).push(value);
        break;
      }
      case '--case':
        if (!CaseIdSchema.safeParse(value).success) throw new Error(`用例标识不合法：${value}`);
        (result.caseIds ??= []).push(value);
        break;
      case '--environment':
        if (!ProfileNameSchema.safeParse(value).success) throw new Error(`环境名称不合法：${value}`);
        result.environment = value;
        break;
      case '--project': result.project = value; break;
      case '--resume': result.resume = value; break;
      case '--run':
        if (!RUN_ID.test(value)) throw new Error(`运行标识不合法：${value}`);
        result.runId = value;
        break;
      case '--openapi': (result.openapi ??= []).push(value); break;
    }
  }
  if ((command === 'reqs' || command === 'plan') && !result.modules?.length) throw new Error(`${command} 需要 --module`);
  if (result.modules) result.modules = [...new Set(result.modules)];
  if (result.caseIds) result.caseIds = [...new Set(result.caseIds)];
  if (result.openapi) result.openapi = [...new Set(result.openapi)];
  return result;
}
