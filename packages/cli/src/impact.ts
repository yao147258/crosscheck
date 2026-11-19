import { analyzeImpact, type ImpactReport, type ImpactSnapshot } from '@crosscheck/core';
import type { CliArgs } from './args';
import { InterruptedError, withInterrupt } from './context';
import { ImpactInputError, loadImpactSnapshots } from './impact/snapshot';
import { formatImpactText, projectImpactReport } from './impact/report';

export async function impactCommand(args: CliArgs, log: (s: string) => void, signal?: AbortSignal): Promise<number> {
  let report: ImpactReport;
  let current: ImpactSnapshot | undefined;
  let code: number;
  let operation: AbortSignal | undefined;
  try {
    report = await withInterrupt(signal, async (operationSignal) => {
      operation = operationSignal;
      const snapshots = await loadImpactSnapshots(args.project, args.since ?? 'HEAD', operationSignal);
      operationSignal.throwIfAborted();
      current = snapshots.current;
      return analyzeImpact(snapshots.base, snapshots.current, snapshots.baseline);
    });
    code = report.complete ? 0 : 2;
  } catch (error) {
    // 不信任异常正文或用户输入的 ref；失败只输出固定诊断，无法解析的基线留空。
    const cancelled = signal?.aborted || operation?.aborted || error instanceof InterruptedError;
    code = cancelled || error instanceof ImpactInputError ? 2 : 3;
    report = {
      version: 1, baseline: '', complete: false, changes: [], impacts: [],
      diagnostics: [{ code: cancelled ? 'cancelled' : code === 2 ? 'input-error' : 'host-error', message: '' }],
      limitations: ['自然语言步骤的依赖未被完整记录，未发现关联不代表没有影响。', '确定影响表示存在确定依赖，不表示用例必然失败。'],
      advisories: ['请先解决输入、基线或宿主问题，再重新分析；本命令不会修改或确认工件。'],
    };
  }
  const dto = projectImpactReport(report, current);
  log(args.json ? JSON.stringify(dto) : formatImpactText(dto));
  return code === 0 && !dto.complete ? 2 : code;
}
