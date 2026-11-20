import { ImpactBudget, ImpactLimit } from './budget';
import type { ImpactCertainty, ImpactDiagnostic, ImpactNode, ImpactSnapshot } from './types';

type Side = 'base' | 'current';
export interface Edge { target: string; certainty: ImpactCertainty; description?: string }
export interface DependencyGraph { edges: Map<string, Edge[]>; nodes: Map<string, ImpactNode>; diagnostics: ImpactDiagnostic[] }
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const filename = (file: string) => file.replace(/\\/g, '/').split('/').pop() ?? '';
export function normalizeSource(path: string): string | undefined {
  const s = path.replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').includes('..') || s.includes('\0')) return undefined;
  const result = s.split('/').filter((part) => part && part !== '.').join('/');
  return result || undefined;
}

export function buildDependencies(snapshot: ImpactSnapshot, side: Side, budget = new ImpactBudget()): DependencyGraph {
  const nodes = new Map<string, ImpactNode>();
  const diagnostics: ImpactDiagnostic[] = [];
  const ids = new Set<string>();
  const profile = new Map<string, string>();
  const edges = new Map<string, Edge[]>();
  const edgeKeys = new Set<string>();
  const documents = new Map<string, ImpactNode>();
  const add = (source: string, target: string, certainty: ImpactCertainty, description?: string) => {
    budget.spend();
    const identity = JSON.stringify([source, target, certainty, description]);
    if (edgeKeys.has(identity)) return;
    edgeKeys.add(identity);
    const values = edges.get(source) ?? [];
    values.push({ target, certainty, description });
    edges.set(source, values);
  };
  const diagnostic = (code: string, node: ImpactNode, message: string) => { const d = { code, side, file: node.file, message }; budget.emit(d); diagnostics.push(d); };
  try {
  for (const node of snapshot.nodes) {
    budget.spend();
    if (node.kind === 'document') { const path = normalizeSource(node.file); if (path && !documents.has(path)) documents.set(path, node); }
    if (nodes.has(node.key)) diagnostic('duplicate-key', node, `节点键重复：${node.key}`);
    else nodes.set(node.key, node);
    const id = node.id ?? (typeof obj(node.value).id === 'string' ? obj(node.value).id as string : undefined);
    if (id && (node.kind === 'case' || node.kind === 'clause')) {
      const identity = `${node.kind}:${id}`;
      if (ids.has(identity)) diagnostic('duplicate-id', node, `标识重复：${identity}`);
      ids.add(identity);
    }
    if (node.kind === 'profile' && node.id) profile.set(`${filename(node.file)}\0${node.id}`, node.key);
  }
  const ref = (node: ImpactNode, file: string, id: unknown) => {
    if (typeof id !== 'string' || !id) return;
    const key = profile.get(`${file}\0${id}`);
    if (key) add(key, node.key, 'definite');
    else diagnostic('missing-reference', node, `引用不存在：${file}:${id}`);
  };
  const source = (node: ImpactNode, value: unknown) => {
    const path = obj(value).file;
    if (typeof path !== 'string') return;
    const normalized = normalizeSource(path);
    if (!normalized) { diagnostic('invalid-source', node, '来源路径无效'); return; }
    budget.spend();
    const document = documents.get(normalized);
    if (document) add(document.key, node.key, 'possible');
  };
  for (const node of nodes.values()) {
    budget.spend();
    const value = obj(node.value);
    if (node.kind === 'clause') source(node, value.source);
    if (node.kind === 'case') {
      for (const id of list(value.covers)) {
        const key = `clause:${id}`;
        if (nodes.has(key)) add(key, node.key, 'definite');
        else diagnostic('missing-reference', node, `引用不存在：${key}`);
      }
      ref(node, 'auth.yaml', value.actor);
      for (const id of list(value.fixtures)) ref(node, 'fixtures.yaml', id);
    }
    if (node.kind !== 'profile') continue;
    switch (filename(node.file)) {
      case 'environments.yaml': ref(node, 'fixtures.yaml', value.reset); break;
      case 'auth.yaml': ref(node, 'environments.yaml', value.environment); break;
      case 'api-catalog.yaml':
      case 'pages.yaml':
        ref(node, 'environments.yaml', value.environment); ref(node, 'auth.yaml', value.actor);
        if (Array.isArray(value.sources)) value.sources.forEach((item) => source(node, item));
        break;
      case 'fixtures.yaml':
        if (value.kind === 'http') ref(node, 'api-catalog.yaml', value.operation);
        if (value.kind === 'sql') ref(node, 'data-model.yaml', value.query);
        break;
      case 'data-model.yaml': if (node.id !== '$connection') ref(node, 'data-model.yaml', '$connection'); break;
    }
  }
  } catch (e) { if (!(e instanceof ImpactLimit)) throw e; }
  for (const values of edges.values()) values.sort((a, b) => a.target.localeCompare(b.target) || a.certainty.localeCompare(b.certainty));
  return { nodes, edges, diagnostics };
}
