import { CaseIdSchema, ProfileNameSchema } from '@crosscheck/core';
export interface CliArgs { command: 'run' | 'report' | 'help'; project: string; environment?: string; modules?: string[]; caseIds?: string[]; resume?: string | true; runId?: string; open: boolean }
export const HELP = `Crosscheck 本地验收 CLI（Node >=22.12）
  crosscheck run [--module <id>]... [--case <id>]... [--resume [runId]] [--project <目录>] [--environment <名称>] [--open]
  crosscheck report <runId> [--project <目录>] [--open]
  crosscheck --help
重复 module/case 各自为集合，两类筛选取交集。未知/空选择不视为通过。
report 仅读取历史快照与真实证据，离线重建 JSON/JUnit/HTML。
不自动确认输入；AI 可按需使用 Playwright Chromium 操作测试页面（需安装 Chromium）；HTTP-only 不启动浏览器。
--open 仅打开系统默认浏览器查看报告；测试浏览器不提供网络隔离保证。
退出码：0 全 PASS；1 含 FAIL（疑似 bug 待人工）；2 阻断/不确定/空/中断/参数错误；3 宿主错误优先。`;
export function parseArgs(args: string[]): CliArgs {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) return { command: 'help', project: process.cwd(), open: false };
  const command = args[0];
  if (command !== 'run' && command !== 'report') throw new Error('请选择 run 或 report；使用 --help 查看参数');
  const result: CliArgs = { command, project: process.cwd(), open: false };
  const seen = new Set<string>(); let index = 1;
  if (command === 'report') {
    result.runId = args[index++];
    if (!result.runId || !/^\d{8}T\d{9}Z-[a-f0-9]{32}$/.test(result.runId)) throw new Error('report 需要合法的 runId');
  }
  while (index < args.length) {
    const flag = args[index++]!;
    if (!['--module', '--case', '--resume', '--project', '--environment', '--open'].includes(flag) || command === 'report' && !['--project', '--open'].includes(flag)) throw new Error('未知或不适用于该子命令的参数');
    if (seen.has(flag) && !['--module', '--case'].includes(flag)) throw new Error('单值参数不能重复');
    seen.add(flag);
    if (flag === '--open') { result.open = true; continue; }
    if (flag === '--resume' && (!args[index] || args[index]!.startsWith('--'))) { result.resume = true; continue; }
    const value = args[index++];
    if (!value || value.startsWith('--')) throw new Error('参数缺少非空值');
    if (flag === '--module') { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('模块名不合法'); (result.modules ??= []).push(value); }
    if (flag === '--case') { if (!CaseIdSchema.safeParse(value).success) throw new Error('用例标识不合法'); (result.caseIds ??= []).push(value); }
    if (flag === '--environment') { if (!ProfileNameSchema.safeParse(value).success) throw new Error('环境名称不合法'); result.environment = value; }
    if (flag === '--project') result.project = value;
    if (flag === '--resume') result.resume = value;
  }
  if (result.modules) result.modules = [...new Set(result.modules)];
  if (result.caseIds) result.caseIds = [...new Set(result.caseIds)];
  return result;
}
