import { describe, expect, it } from 'vitest';
import { compareSnapshots, type ImpactNode, type ImpactSnapshot } from '../src/index';

const node = (key: string, value: unknown, kind: ImpactNode['kind'] = 'case', file = 'cases.yaml'): ImpactNode => ({ key, value, kind, file });
const snapshot = (nodes: ImpactNode[], files: ImpactSnapshot['files'] = []): ImpactSnapshot => ({ nodes, files, diagnostics: [] });

describe('快照差异', () => {
  it('按稳定键排序新增、修改、删除并只返回字段路径', () => {
    const base = snapshot([node('case:z', { secret: '旧内容' }), node('case:b', { nested: { 'a/b~c': 1 }, keep: 1 }), node('case:d', {})]);
    const current = snapshot([node('case:a', { secret: '新内容' }), node('case:b', { keep: 1, nested: { 'a/b~c': 2, extra: true } })]);
    const changes = compareSnapshots(base, current);
    expect(changes).toEqual([
      { key: 'case:a', kind: 'added', fields: ['/'] },
      { key: 'case:b', kind: 'modified', fields: ['/nested/a~1b~0c', '/nested/extra'] },
      { key: 'case:d', kind: 'deleted', fields: ['/'] },
      { key: 'case:z', kind: 'deleted', fields: ['/'] },
    ]);
    expect(JSON.stringify(changes)).not.toContain('旧内容');
    expect(JSON.stringify(changes)).not.toContain('新内容');
  });

  it('忽略对象键顺序并保留普通数组顺序', () => {
    expect(compareSnapshots(snapshot([node('case:a', { a: 1, b: { x: 2, y: 3 }, steps: [1, 2] })]), snapshot([node('case:a', { steps: [1, 2], b: { y: 3, x: 2 }, a: 1 })]))).toEqual([]);
    expect(compareSnapshots(snapshot([node('case:a', { steps: [1, 2] })]), snapshot([node('case:a', { steps: [2, 1] })]))).toEqual([{ key: 'case:a', kind: 'modified', fields: ['/steps/0', '/steps/1'] }]);
  });

  it('仅将案例的 covers 和 fixtures 归一化为集合', () => {
    const before = { covers: ['B', 'A', 'A'], fixtures: ['y', 'x'] };
    const after = { covers: ['A', 'B'], fixtures: ['x', 'y', 'x'] };
    expect(compareSnapshots(snapshot([node('case:a', before)]), snapshot([node('case:a', after)]))).toEqual([]);
    expect(compareSnapshots(snapshot([node('profile:a', before, 'profile')]), snapshot([node('profile:a', after, 'profile')]))).not.toEqual([]);
  });

  it('文档和笔记统一换行且仅报告文本字段', () => {
    const base = snapshot([node('document:a', { text: '一\r\n二\r\n', metadata: '旧' }, 'document'), node('notes:project', '第一行\r\n第二行', 'notes')]);
    const same = snapshot([node('document:a', { text: '一\n二\n', metadata: '新' }, 'document'), node('notes:project', '第一行\n第二行', 'notes')]);
    expect(compareSnapshots(base, same)).toEqual([]);
    const changed = snapshot([node('document:a', { text: '其他', metadata: '新' }, 'document'), node('notes:project', '不同', 'notes')]);
    expect(compareSnapshots(base, changed)).toEqual([{ key: 'document:a', kind: 'modified', fields: ['/text'] }, { key: 'notes:project', kind: 'modified', fields: ['/text'] }]);
  });

  it('确认文件缺失时报告正常新增和删除', () => {
    const present = snapshot([node('case:a', { x: 1 })], [{ file: 'cases.yaml', state: 'present' }]);
    const missing = snapshot([], [{ file: 'cases.yaml', state: 'missing' }]);
    expect(compareSnapshots(missing, present)).toEqual([{ key: 'case:a', kind: 'added', fields: ['/'] }]);
    expect(compareSnapshots(present, missing)).toEqual([{ key: 'case:a', kind: 'deleted', fields: ['/'] }]);
    const empty = snapshot([], [{ file: 'cases.yaml', state: 'present' }]);
    expect(compareSnapshots(present, empty)).toEqual([{ key: 'case:a', kind: 'deleted', fields: ['/'] }]);
  });

  it('无效文件不制造同文件新增或删除', () => {
    const present = snapshot([node('case:a', { x: 1 })], [{ file: 'cases.yaml', state: 'present' }]);
    const invalid = snapshot([], [{ file: 'cases.yaml', state: 'invalid' }]);
    expect(compareSnapshots(invalid, present)).toEqual([]);
    expect(compareSnapshots(present, invalid)).toEqual([]);
  });

  it('跨文件未知案例身份不伪报新增删除但仍比较共有实体', () => {
    const invalid = snapshot([node('case:shared', { x: 1 }, 'case', 'cases/b.yaml')], [{ file: 'cases/a.yaml', state: 'invalid' }, { file: 'cases/b.yaml', state: 'present' }]);
    const known = snapshot([node('case:shared', { x: 2 }, 'case', 'cases/b.yaml'), node('case:new', {}, 'case', 'cases/b.yaml')], [{ file: 'cases/a.yaml', state: 'missing' }, { file: 'cases/b.yaml', state: 'present' }]);
    expect(compareSnapshots(invalid, known)).toEqual([{ key: 'case:shared', kind: 'modified', fields: ['/x'] }]);
    expect(compareSnapshots(known, invalid)).toEqual([{ key: 'case:shared', kind: 'modified', fields: ['/x'] }]);
  });

  it('无效需求文件只抑制未知侧的条款单侧变化', () => {
    const base = snapshot([], [{ file: 'requirements/a.yaml', state: 'invalid' }]);
    const current = snapshot([node('clause:x', {}, 'clause', 'requirements/b.yaml'), node('case:x', {}, 'case', 'cases/b.yaml')]);
    expect(compareSnapshots(base, current)).toEqual([{ key: 'case:x', kind: 'added', fields: ['/'] }]);
    expect(compareSnapshots(current, base)).toEqual([{ key: 'case:x', kind: 'deleted', fields: ['/'] }]);
  });

  it('文件类别未知时保守抑制跨文件身份变化', () => {
    const base = snapshot([], [{ file: 'unknown.yaml', state: 'invalid' }]);
    const current = snapshot([node('case:x', {}, 'case', 'cases/b.yaml'), node('clause:x', {}, 'clause', 'requirements/b.yaml')]);
    expect(compareSnapshots(base, current)).toEqual([]);
  });

  it('无文件记录的纯逻辑夹具仍可比较并隔离其他无效文件', () => {
    const base = snapshot([node('case:a', 1)], [{ file: 'profiles/auth.yaml', state: 'invalid' }]);
    const current = snapshot([node('case:b', 2)], [{ file: 'profiles/auth.yaml', state: 'invalid' }]);
    expect(compareSnapshots(base, current)).toEqual([{ key: 'case:a', kind: 'deleted', fields: ['/'] }, { key: 'case:b', kind: 'added', fields: ['/'] }]);
  });

  it('安全比较特殊对象键且不修改输入', () => {
    const base = snapshot([node('case:__proto__', JSON.parse('{"__proto__":{"value":1},"covers":["b","a"]}'))]);
    const current = snapshot([node('case:__proto__', JSON.parse('{"covers":["a","b"],"__proto__":{"value":2}}'))]);
    const before = JSON.stringify([base, current]);
    expect(compareSnapshots(base, current)).toEqual([{ key: 'case:__proto__', kind: 'modified', fields: ['/__proto__/value'] }]);
    expect(JSON.stringify([base, current])).toBe(before);
  });
});
