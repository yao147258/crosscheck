import { compareSnapshots } from './compare';
import { buildDependencies, type DependencyGraph, type Edge } from './dependencies';
import { ImpactBudget, ImpactLimit } from './budget';
import type { ImpactCertainty, ImpactDiagnostic, ImpactNode, ImpactReason, ImpactReport, ImpactSnapshot } from './types';

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const file = (node: ImpactNode) => node.file.replace(/\\/g, '/').split('/').pop();
const limitDiagnostic: ImpactDiagnostic = { code: 'analysis-limit', message: '分析或输出达到资源上限，结果已截断，请缩小范围复核' };
const limitations = ['自然语言步骤的依赖未被完整记录，未发现关联不代表没有影响。', '确定影响表示存在确定依赖，不表示用例必然失败。'];

// 先以迭代方式检查深度/宽度，防止比较、规范化和 JSON 序列化先耗尽堆栈。
function checkInputs(snapshots: ImpactSnapshot[], budget: ImpactBudget): void {
  let count = 0;
  for (const snapshot of snapshots) for (const node of snapshot.nodes) {
    if (++count > 10000) budget.fail();
    budget.spend();
    const stack = [{ value: node.value, depth: 0 }];
    while (stack.length) {
      budget.spend();
      const { value, depth } = stack.pop()!;
      if (depth > 64) budget.fail();
      if (value !== null && typeof value === 'object') {
        let children = 0;
        for (const key in value) if (Object.hasOwn(value, key)) {
          if (++children > 20000) budget.fail();
          budget.spend();
          stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
        }
      }
    }
  }
}

export function analyzeImpact(base: ImpactSnapshot, current: ImpactSnapshot, baseline: string): ImpactReport {
  const budget = new ImpactBudget();
  try { checkInputs([base, current], budget); }
  catch (e) {
    if (!(e instanceof ImpactLimit)) throw e;
    return { version: 1, baseline, complete: false, changes: [], impacts: [], diagnostics: [limitDiagnostic], advisories: [], limitations };
  }
  const changes = compareSnapshots(base, current, budget);
  const graphs = { base: buildDependencies(base, 'base', budget), current: buildDependencies(current, 'current', budget) };
  const collected = new Map<string, ImpactReason[]>();
  const add = (target: string, reason: ImpactReason) => {
    if (target === reason.source) return;
    budget.reason(); budget.emit([target, reason]);
    const reasons = collected.get(target) ?? [];
    reasons.push(reason); collected.set(target, reasons);
  };
  const targets = (graph: DependencyGraph, kind: ImpactNode['kind']) => [...graph.nodes.values()].filter((n) => n.kind === kind).map((n) => n.key).sort(order);
  const conservative = { base: { cases: targets(graphs.base, 'case'), profiles: targets(graphs.base, 'profile') }, current: { cases: targets(graphs.current, 'case'), profiles: targets(graphs.current, 'profile') } };
  const walk = (graph: DependencyGraph, side: 'base' | 'current', root: string, defaultEnvironment: boolean) => {
    if (!graph.nodes.has(root)) return;
    type Item = { key: string; chain: string[]; certainty: ImpactCertainty; description?: string };
    const queue: Item[] = [{ key: root, chain: [root], certainty: 'definite' }];
    const seen = new Set([`${root}\0definite`]);
    let head = 0;
    while (head < queue.length) {
      budget.spend();
      const item = queue[head++]!;
      if (item.key !== root) add(item.key, { source: root, chain: item.chain, certainty: item.certainty, side, ...(item.description ? { description: item.description } : {}) });
      const enqueue = (edge: Edge) => {
        budget.spend();
        if (item.chain.includes(edge.target)) return;
        const certainty = item.certainty === 'possible' || edge.certainty === 'possible' ? 'possible' : 'definite';
        const marker = `${edge.target}\0${certainty}`;
        if (seen.has(marker)) return;
        seen.add(marker);
        // 链元素同样计费，复制前检查，避免深链和宽队列隐藏工作量。
        budget.spend(item.chain.length + 1);
        queue.push({ key: edge.target, chain: [...item.chain, edge.target], certainty, description: item.description ?? edge.description });
      };
      for (const edge of graph.edges.get(item.key) ?? []) enqueue(edge);
      const visited = graph.nodes.get(item.key)!;
      let description: string | undefined;
      if (visited.kind === 'notes') description = '项目笔记未记录结构化来源依赖，需人工复核。';
      if (visited.kind === 'profile') description = file(visited) === 'guardrails.yaml' ? '全局安全条件发生变化，需复核用例。' : '自然语言步骤未记录结构化依赖，无法证明无关。';
      if (visited.key === root && visited.kind === 'config' && defaultEnvironment) description = '默认环境变化，需复核用例。';
      // 按需生成，绝不先构造 roots × cases 的 extra 数组。
      if (description) {
        if (visited.kind === 'notes') for (const target of conservative[side].profiles) enqueue({ target, certainty: 'possible', description });
        for (const target of conservative[side].cases) enqueue({ target, certainty: 'possible', description });
      }
    }
  };
  const advisories: string[] = [];
  try {
    for (const change of changes) for (const side of ['base', 'current'] as const) {
      budget.spend();
      walk(graphs[side], side, change.key, change.fields.some((field) => field === '/' || field === '/defaultEnvironment' || field.startsWith('/defaultEnvironment/')));
    }
    const advise = (message: string) => { budget.spend(); budget.emit(message); advisories.push(message); };
    const covered = new Set<string>();
    for (const node of graphs.current.nodes.values()) if (node.kind === 'case') for (const id of Array.isArray(object(node.value).covers) ? object(node.value).covers as string[] : []) { budget.spend(); covered.add(id); }
    const coverageUnknown = budget.limited || current.diagnostics.some((d) => d.code === 'file-limit') || current.files.some((f) => f.state === 'invalid' && /(^|\/)cases(\/|$)/.test(f.file.replaceAll('\\', '/')));
    if (coverageUnknown) advise('用例范围存在无效输入，活动条款覆盖无法确认，请复核全部模块。');
    for (const node of graphs.current.nodes.values()) {
      budget.spend();
      if (!coverageUnknown && node.kind === 'clause' && (object(node.value).status === 'active' || object(node.value).status === undefined) && !covered.has(node.id ?? String(object(node.value).id ?? ''))) advise(`活动条款未被用例覆盖：${node.key}`);
    }
    if (changes.some((change) => change.key === 'config:project' && change.fields.some((field) => field === '/' || field === '/requirementsDocs' || field.startsWith('/requirementsDocs/')))) advise('需求文档范围发生变化，请复核条款范围。');
    for (const change of changes) {
      budget.spend();
      if (!change.key.startsWith('document:')) continue;
      const mapped = [graphs.base, graphs.current].some((graph) => (graph.edges.get(change.key) ?? []).some((edge) => { budget.spend(); return graph.nodes.get(edge.target)?.kind === 'clause'; }));
      if (!mapped) advise(`需求文档未映射条款，请复核需求抽取：${change.key}`);
    }
  } catch (e) { if (!(e instanceof ImpactLimit)) throw e; }
  const diagnostics = [...base.diagnostics.map((d) => ({ ...d, side: 'base' as const })), ...current.diagnostics.map((d) => ({ ...d, side: 'current' as const })), ...graphs.base.diagnostics, ...graphs.current.diagnostics, ...(budget.limited ? [limitDiagnostic] : [])].sort((a, b) => order(`${a.side ?? ''}\0${a.code}\0${a.file ?? ''}\0${a.message}`, `${b.side ?? ''}\0${b.code}\0${b.file ?? ''}\0${b.message}`));
  const impacts = [...collected].sort(([a], [b]) => order(a, b)).map(([key, reasons]) => {
    reasons.sort((a, b) => order(a.source, b.source) || order(a.side, b.side) || order(a.certainty, b.certainty) || order(a.chain.join('\0'), b.chain.join('\0')));
    return { key, certainty: reasons.some((r) => r.certainty === 'definite') ? 'definite' as const : 'possible' as const, reasons };
  });
  return { version: 1, baseline, complete: diagnostics.length === 0, changes, impacts, diagnostics, advisories: advisories.sort(order), limitations };
}
