import { canonicalize } from '../approvals/hash';
import { ImpactBudget, ImpactLimit } from './budget';
import type { ImpactChange, ImpactNode, ImpactSnapshot } from './types';

const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// 转为键值对数组，避免 canonicalize 对特殊对象键的处理丢失数据。
function safeValue(value: unknown): unknown {
  if (Array.isArray(value)) return ['array', value.map((item) => safeValue(item === undefined ? null : item))];
  if (object(value)) return ['object', Object.keys(value).filter((key) => value[key] !== undefined).sort(order).map((key) => [key, safeValue(value[key])])];
  return ['scalar', value];
}

function fingerprint(value: unknown): string {
  return canonicalize(safeValue(value));
}

function normalized(node: ImpactNode): unknown {
  if (node.kind === 'document' || node.kind === 'notes') {
    const text = object(node.value) ? node.value.text : node.value;
    return typeof text === 'string' ? text.replace(/\r\n/g, '\n') : text;
  }
  if (node.kind !== 'case' || !object(node.value)) return node.value;
  const result = Object.assign(Object.create(null) as Record<string, unknown>, node.value);
  for (const key of ['covers', 'fixtures']) {
    const entries = result[key];
    if (Array.isArray(entries)) {
      const unique = new Map(entries.map((entry) => [fingerprint(entry), entry]));
      result[key] = [...unique.entries()].sort(([a], [b]) => order(a, b)).map(([, entry]) => entry);
    }
  }
  return result;
}

function diff(base: unknown, current: unknown, path: string, budget: ImpactBudget): string[] {
  budget.spend();
  if (fingerprint(base) === fingerprint(current)) return [];
  if (Array.isArray(base) && Array.isArray(current)) {
    const result: string[] = [];
    for (let i = 0; i < Math.max(base.length, current.length); i++) {
      const next = `${path}/${i}`;
      if (i >= base.length || i >= current.length) { budget.spend(); budget.emit(next); result.push(next); }
      else result.push(...diff(base[i], current[i], next, budget));
    }
    return result;
  }
  if (object(base) && object(current)) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(current)])].sort(order);
    const result: string[] = [];
    for (const key of keys) {
      const before = Object.hasOwn(base, key) && base[key] !== undefined;
      const after = Object.hasOwn(current, key) && current[key] !== undefined;
      const next = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (before !== after) { budget.spend(); budget.emit(next); result.push(next); }
      else if (before) result.push(...diff(base[key], current[key], next, budget));
    }
    return result;
  }
  return [path || '/'];
}

// 无法识别的无效文件可能包含任一跨文件实体，必须保守处理。
function mayContain(file: string, kind: 'case' | 'clause'): boolean {
  const parts = file.replace(/\\/g, '/').split('/');
  if (parts.includes('cases')) return kind === 'case';
  if (parts.includes('requirements')) return kind === 'clause';
  if (parts.includes('system') || parts.includes('profiles')) return false;
  return true;
}

function unknownIdentity(snapshot: ImpactSnapshot, node: ImpactNode): boolean {
  const kind = node.kind;
  return (kind === 'case' || kind === 'clause') && snapshot.files.some((file) => file.state === 'invalid' && mayContain(file.file, kind));
}

export function compareSnapshots(base: ImpactSnapshot, current: ImpactSnapshot, budget = new ImpactBudget()): ImpactChange[] {
  const unavailable = new Set([...base.files, ...current.files].filter((file) => file.state === 'invalid').map((file) => file.file));
  const oldNodes = new Map(base.nodes.map((node) => [node.key, node]));
  const newNodes = new Map(current.nodes.map((node) => [node.key, node]));
  const keys = [...new Set([...oldNodes.keys(), ...newNodes.keys()])].sort(order);
  const changes: ImpactChange[] = [];
  try { for (const key of keys) {
    budget.spend();
    const before = oldNodes.get(key);
    const after = newNodes.get(key);
    if ((before && unavailable.has(before.file)) || (after && unavailable.has(after.file))) continue;
    if (!before && after && !unknownIdentity(base, after)) changes.push({ key, kind: 'added', fields: ['/'] });
    else if (!after && before && !unknownIdentity(current, before)) changes.push({ key, kind: 'deleted', fields: ['/'] });
    else if (!before || !after) continue;
    else {
      const textOnly = before.kind === 'document' || before.kind === 'notes' || after.kind === 'document' || after.kind === 'notes';
      const fields = diff(normalized(before), normalized(after), textOnly ? '/text' : '', budget).sort(order);
      if (fields.length) changes.push({ key, kind: 'modified', fields: textOnly ? ['/text'] : fields });
    }
    if (changes.length > 5000) { changes.pop(); budget.fail(); }
    if (changes.at(-1)?.key === key) {
      try { budget.emit(changes.at(-1)); } catch (e) { changes.pop(); throw e; }
    }
  } } catch (e) { if (!(e instanceof ImpactLimit)) throw e; }
  return changes;
}
