import { describe, expect, it } from 'vitest';
import { analyzeImpact, type ImpactNode, type ImpactSnapshot } from '../src/index';

const n = (kind: ImpactNode['kind'], id: string, value: unknown, file = ''): ImpactNode => ({ kind, id, value, file: file || (kind === 'profile' ? '.crosscheck/system/auth.yaml' : `${kind}s/test.yaml`), key: kind === 'profile' ? `profile:${file.split('/').pop()}:${id}` : `${kind}:${id}` });
const p = (file: string, id: string, value: unknown) => n('profile', id, value, `.crosscheck/system/${file}`);
const snap = (...nodes: ImpactNode[]): ImpactSnapshot => ({ nodes, files: [], diagnostics: [] });
const caseNode = (id: string, covers: string[], actor = 'user', fixtures: string[] = []) => n('case', id, { id, covers, actor, fixtures });
const clause = (id: string, text = '旧') => n('clause', id, { id, text, status: 'active', source: { file: 'docs/r.md' } });
const actor = () => p('auth.yaml', 'user', { kind: 'anonymous' });
const reason = (report: ReturnType<typeof analyzeImpact>, target: string, source: string, side: 'base' | 'current', chain: string[], certainty: 'definite' | 'possible' = 'definite') => expect(impact(report, target)?.reasons).toContainEqual(expect.objectContaining({ source, side, certainty, chain }));
const impact = (report: ReturnType<typeof analyzeImpact>, key: string) => report.impacts.find((item) => item.key === key);

describe('依赖图与影响传播', () => {
  it('多画像乘多用例的原因与输出共享全局预算，稳定截断并明确不完整', () => {
    const profiles = Array.from({ length: 160 }, (_, i) => p('auth.yaml', `u${i}`, { kind: 'anonymous', revision: 1 }));
    const cases = Array.from({ length: 160 }, (_, i) => caseNode(`A-TC-${i + 1}`, [], 'u0'));
    const base = snap(...profiles, ...cases);
    const current = snap(...profiles.map((node) => ({ ...node, value: { kind: 'anonymous', revision: 2 } })), ...cases);
    const report = analyzeImpact(base, current, 'abc');
    expect(report.complete).toBe(false);
    expect(report.diagnostics).toContainEqual({ code: 'analysis-limit', message: '分析或输出达到资源上限，结果已截断，请缩小范围复核' });
    expect(report.impacts.length).toBeGreaterThan(0);
    expect(report.impacts.flatMap((i) => i.reasons).length).toBeLessThanOrEqual(10000);
    expect(JSON.stringify(report).length).toBeLessThan(2000000);
    expect(analyzeImpact(base, current, 'abc')).toEqual(report);
  });
  it('图构建和极宽变更字段同样受预算限制，不等待遍历才限额', () => {
    const huge = Object.fromEntries(Array.from({ length: 21000 }, (_, i) => [`k${i}`, i]));
    const base = snap(p('auth.yaml', 'u', {}));
    const current = snap(p('auth.yaml', 'u', huge));
    const report = analyzeImpact(base, current, 'abc');
    expect(report.complete).toBe(false);
    expect(report.diagnostics.some((d) => d.code === 'analysis-limit')).toBe(true);
    expect(report.changes.flatMap((c) => c.fields).length).toBeLessThanOrEqual(20000);
    const graph = snap(...Array.from({ length: 11000 }, (_, i) => clause(`A-AC-${i + 1}`)));
    expect(analyzeImpact(graph, graph, 'abc').diagnostics.some((d) => d.code === 'analysis-limit')).toBe(true);
  });
  it('单条超长变更标识不能在输出预算失败后留在报告内', () => {
    const node = { ...actor(), key: `profile:${'x'.repeat(1100000)}` };
    const report = analyzeImpact(snap(), snap(node), 'abc');
    expect(report.complete).toBe(false);
    expect(JSON.stringify(report).length).toBeLessThan(2000000);
    expect(report.changes).toEqual([]);
  });
  it('过深 JSON 在比较递归前拒绝，不产生栈崩溃或伪删除', () => {
    let deep: unknown = null;
    for (let i = 0; i < 300; i++) deep = { inner: deep };
    const report = analyzeImpact(snap(p('fixtures.yaml', 'f', {})), snap(p('fixtures.yaml', 'f', deep)), 'abc');
    expect(report.complete).toBe(false);
    expect(report.diagnostics.some((d) => d.code === 'analysis-limit')).toBe(true);
    expect(report.changes).toEqual([]);
  });
  it('文件候选被截断时未枚举用例也可能覆盖全部模块', () => {
    const current = snap(clause('A-AC-1'));
    current.diagnostics.push({ code: 'file-limit', message: '资源缺口' });
    const report = analyzeImpact(current, current, 'abc');
    expect(report.advisories.join(' ')).not.toContain('活动条款未被用例覆盖');
    expect(report.advisories.join(' ')).toContain('覆盖无法确认');
  });
  it('任意失效用例模块可能跨模块覆盖，不能断言其他活动条款未覆盖', () => {
    const current = snap(clause('A-AC-1'), clause('B-AC-1'), actor());
    current.files.push({ file: '.crosscheck/cases/C.yaml', state: 'invalid' });
    current.diagnostics.push({ code: 'invalid-file', message: '文件无效' });
    const report = analyzeImpact(current, current, 'abc');
    expect(report.advisories.some((a) => a.includes('活动条款未被用例覆盖'))).toBe(false);
    expect(report.advisories).toContain('用例范围存在无效输入，活动条款覆盖无法确认，请复核全部模块。');
    const empty = analyzeImpact(snap(clause('A-AC-1')), snap(clause('A-AC-1')), 'abc');
    expect(empty.advisories).toContain('活动条款未被用例覆盖：clause:A-AC-1');
  });
  it('按 covers 精确传播并保留跨模块与历史引用', () => {
    const base = snap(clause('A-AC-1'), clause('B-AC-1'), caseNode('B-TC-1', ['A-AC-1']), caseNode('A-TC-2', ['B-AC-1']), actor());
    const current = snap(clause('A-AC-1', '新'), clause('B-AC-1'), caseNode('B-TC-1', ['B-AC-1']), caseNode('A-TC-2', ['B-AC-1']), actor());
    const report = analyzeImpact(base, current, 'abc');
    expect(impact(report, 'case:B-TC-1')?.reasons).toContainEqual(expect.objectContaining({ source: 'clause:A-AC-1', side: 'base', certainty: 'definite', chain: ['clause:A-AC-1', 'case:B-TC-1'] }));
    expect(impact(report, 'case:A-TC-2')?.reasons.some((r) => r.source === 'clause:A-AC-1' && r.certainty === 'definite')).not.toBe(true);
  });
  it('画像各引用和环按各侧独立传播，连接不直接依赖夹具', () => {
    const env = p('environments.yaml', 'dev', { reset: 'setup' });
    const user = p('auth.yaml', 'user', { kind: 'form', environment: 'dev' });
    const op = p('api-catalog.yaml', 'create', { environment: 'dev', actor: 'user', sources: [] });
    const page = p('pages.yaml', 'home', { environment: 'dev', actor: 'user', sources: [] });
    const setup = p('fixtures.yaml', 'setup', { kind: 'http', operation: 'create' });
    const connection = p('data-model.yaml', '$connection', { env: 'OLD' });
    const query = p('data-model.yaml', 'query', { sql: 'SELECT 1' });
    const sql = p('fixtures.yaml', 'sql', { kind: 'sql', query: 'query', connection: { env: 'WRITE' } });
    const old = snap(env, user, op, page, setup, connection, query, sql, clause('A-AC-1'), caseNode('A-TC-1', ['A-AC-1'], 'user', ['setup', 'sql']));
    const now = snap(env, user, op, page, setup, p('data-model.yaml', '$connection', { env: 'NEW' }), query, sql, clause('A-AC-1'), caseNode('A-TC-1', ['A-AC-1'], 'user', ['setup', 'sql']));
    const report = analyzeImpact(old, now, 'abc');
    expect(impact(report, 'profile:fixtures.yaml:sql')?.reasons).toContainEqual(expect.objectContaining({ certainty: 'definite', chain: ['profile:data-model.yaml:$connection', 'profile:data-model.yaml:query', 'profile:fixtures.yaml:sql'] }));
    expect(report.complete).toBe(true);
    const changedEnv = snap(p('environments.yaml', 'dev', { reset: 'setup', value: 2 }), user, op, page, setup, connection, query, sql, clause('A-AC-1'), caseNode('A-TC-1', ['A-AC-1'], 'user', ['setup', 'sql']));
    const cycle = analyzeImpact(old, changedEnv, 'abc');
    expect(impact(cycle, 'profile:pages.yaml:home')?.certainty).toBe('definite');
    expect(impact(cycle, 'case:A-TC-1')?.certainty).toBe('definite');
    expect(impact(cycle, 'profile:environments.yaml:dev')).toBeUndefined();
  });
  it('不跨版本拼接依赖链', () => {
    const old = snap(p('environments.yaml', 'dev', { reset: null, x: 1 }), p('auth.yaml', 'user', { environment: 'dev' }), clause('A-AC-1'), caseNode('A-TC-1', ['A-AC-1'], 'other'), p('auth.yaml', 'other', { kind: 'anonymous' }));
    const now = snap(p('environments.yaml', 'dev', { reset: null, x: 2 }), p('auth.yaml', 'user', { kind: 'anonymous' }), clause('A-AC-1'), caseNode('A-TC-1', ['A-AC-1'], 'user'), p('auth.yaml', 'other', { kind: 'anonymous' }));
    const report = analyzeImpact(old, now, 'abc');
    expect(impact(report, 'case:A-TC-1')?.reasons.some((r) => r.source === 'profile:environments.yaml:dev' && r.certainty === 'definite')).toBe(false);
  });
  it('文档、笔记、配置传播并提示未覆盖条款', () => {
    const config = (defaultEnvironment: string) => n('config', 'project', { requirementsDocs: ['docs/r.md'], defaultEnvironment });
    const doc = (text: string) => ({ ...n('document', 'docs/r.md', text), file: 'docs/r.md' });
    const old = snap(config('dev'), doc('旧'), n('notes', 'project', '旧'), clause('A-AC-1'), actor(), caseNode('A-TC-1', ['A-AC-1']));
    const now = snap(config('prod'), doc('新'), n('notes', 'project', '新'), clause('A-AC-1'), clause('B-AC-1'), actor(), caseNode('A-TC-1', ['A-AC-1']));
    const report = analyzeImpact(old, now, 'abc');
    const reasons = impact(report, 'case:A-TC-1')!.reasons;
    expect(reasons).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'document:docs/r.md', certainty: 'possible' }), expect.objectContaining({ source: 'notes:project', certainty: 'possible' }), expect.objectContaining({ source: 'config:project', certainty: 'possible' })]));
    expect(report.advisories.join(' ')).toContain('B-AC-1');
    expect(JSON.stringify(report)).not.toContain('旧');
  });
  it('同根因保留确定和可能链，多根因分别记录', () => {
    const old = snap(p('auth.yaml', 'user', { kind: 'anonymous', v: 1 }), p('fixtures.yaml', 'setup', { kind: 'command', v: 1 }), clause('A-AC-1'), caseNode('A-TC-1', ['A-AC-1'], 'user', ['setup']));
    const now = snap(p('auth.yaml', 'user', { kind: 'anonymous', v: 2 }), p('fixtures.yaml', 'setup', { kind: 'command', v: 2 }), clause('A-AC-1'), caseNode('A-TC-1', ['A-AC-1'], 'user', ['setup']));
    const item = impact(analyzeImpact(old, now, 'abc'), 'case:A-TC-1')!;
    expect(item.certainty).toBe('definite');
    expect(item.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'profile:auth.yaml:user', certainty: 'definite' }), expect.objectContaining({ source: 'profile:auth.yaml:user', certainty: 'possible', description: expect.stringContaining('结构化依赖') }), expect.objectContaining({ source: 'profile:fixtures.yaml:setup', certainty: 'definite' })]));
  });
  it('删除条款和删除用例保留旧链并提示覆盖缺口', () => {
    const base = snap(clause('A-AC-1'), clause('B-AC-1'), caseNode('A-TC-1', ['A-AC-1', 'B-AC-1']), actor());
    const current = snap(clause('B-AC-1'), actor());
    const report = analyzeImpact(base, current, 'abc');
    expect(impact(report, 'case:A-TC-1')?.reasons).toContainEqual(expect.objectContaining({ source: 'clause:A-AC-1', side: 'base', certainty: 'definite' }));
    expect(report.advisories.join(' ')).toContain('B-AC-1');
  });
  it('范围外来源不建边，非法路径产生诊断', () => {
    const config = n('config', 'project', { requirementsDocs: ['docs/r.md'] });
    const doc = { ...n('document', 'docs/other.md', '旧'), file: 'docs/other.md' };
    const cl = n('clause', 'A-AC-1', { id: 'A-AC-1', source: { file: '../secret' }, status: 'active' });
    const base = snap(config, doc, cl, actor(), caseNode('A-TC-1', ['A-AC-1']));
    const current = snap(config, { ...doc, value: '新' }, cl, actor(), caseNode('A-TC-1', ['A-AC-1']));
    const report = analyzeImpact(base, current, 'abc');
    expect(impact(report, 'clause:A-AC-1')).toBeUndefined();
    expect(report.diagnostics.some((d) => d.code === 'invalid-source')).toBe(true);
  });
  it('逐个变更文档检查两侧规范化来源，删除文档也检查', () => {
    const config = n('config', 'project', { requirementsDocs: ['docs/a.md', 'docs/b.md', 'docs/deleted.md'] });
    const doc = (path: string, text: string) => ({ ...n('document', path, text), file: path });
    const unrelated = n('clause', 'A-AC-1', { id: 'A-AC-1', status: 'active', source: { file: 'docs/a.md' } });
    const mapped = n('clause', 'B-AC-1', { id: 'B-AC-1', status: 'active', source: { file: '.\\docs\\deleted.md' } });
    const base = snap(config, doc('docs/a.md', 'a'), doc('docs/b.md', '旧'), doc('docs/deleted.md', '内容'), unrelated, mapped);
    const current = snap(config, doc('docs/a.md', 'a'), doc('docs/b.md', '新'), unrelated, mapped);
    const report = analyzeImpact(base, current, 'abc');
    expect(report.advisories.join(' ')).toContain('docs/b.md');
    expect(report.advisories.join(' ')).not.toContain('docs/deleted.md');
    reason(report, 'clause:B-AC-1', 'document:docs/deleted.md', 'base', ['document:docs/deleted.md', 'clause:B-AC-1'], 'possible');
    const unmappedDeletion = analyzeImpact(snap(config, doc('docs/deleted.md', '内容'), unrelated), snap(config, unrelated), 'abc');
    expect(unmappedDeletion.advisories.join(' ')).toContain('docs/deleted.md');
  });
  it('特殊连接与名为 connection 的查询各自独立', () => {
    const connection = (v: number) => p('data-model.yaml', '$connection', { v });
    const query = p('data-model.yaml', 'connection', { sql: 'SELECT 1' });
    const fixture = p('fixtures.yaml', 'setup', { kind: 'sql', query: 'connection', connection: { env: 'WRITE' } });
    const report = analyzeImpact(snap(connection(1), query, fixture), snap(connection(2), query, fixture), 'abc');
    expect(report.complete).toBe(true);
    reason(report, 'profile:data-model.yaml:connection', 'profile:data-model.yaml:$connection', 'current', ['profile:data-model.yaml:$connection', 'profile:data-model.yaml:connection']);
    reason(report, 'profile:fixtures.yaml:setup', 'profile:data-model.yaml:$connection', 'current', ['profile:data-model.yaml:$connection', 'profile:data-model.yaml:connection', 'profile:fixtures.yaml:setup']);
    expect(impact(report, 'profile:fixtures.yaml:setup')?.reasons.some((r) => r.chain.length === 2)).toBe(false);
  });
  it('各画像引用边均可产生精确确定链并支持环', () => {
    const fixtures = [p('fixtures.yaml', 'reset', { kind: 'http', operation: 'op' }), p('fixtures.yaml', 'setup', { kind: 'command' })];
    const env = p('environments.yaml', 'dev', { reset: 'reset' });
    const user = p('auth.yaml', 'user', { environment: 'dev' });
    const op = p('api-catalog.yaml', 'op', { environment: 'dev', actor: 'user', sources: [] });
    const page = p('pages.yaml', 'page', { environment: 'dev', actor: 'user', sources: [] });
    const nodes = [env, user, op, page, ...fixtures, clause('A-AC-1'), caseNode('A-TC-1', ['A-AC-1'], 'user', ['setup'])];
    const changed = (root: string) => analyzeImpact(snap(...nodes), snap(...nodes.map((node) => node.key === root ? { ...node, value: { ...node.value as object, changed: true } } : node)), 'abc');
    const edges = [
      ['profile:fixtures.yaml:reset', 'profile:environments.yaml:dev'],
      ['profile:environments.yaml:dev', 'profile:auth.yaml:user'],
      ['profile:environments.yaml:dev', 'profile:api-catalog.yaml:op'],
      ['profile:environments.yaml:dev', 'profile:pages.yaml:page'],
      ['profile:auth.yaml:user', 'profile:api-catalog.yaml:op'],
      ['profile:auth.yaml:user', 'profile:pages.yaml:page'],
      ['profile:api-catalog.yaml:op', 'profile:fixtures.yaml:reset'],
      ['profile:fixtures.yaml:setup', 'case:A-TC-1'],
      ['profile:auth.yaml:user', 'case:A-TC-1'],
    ];
    for (const [source, target] of edges) reason(changed(source!), target!, source!, 'current', [source!, target!]);
  });
  it('文档来源经规范化分别影响 operation 与 page', () => {
    const config = n('config', 'project', { requirementsDocs: ['docs/r.md'] });
    const doc = (text: string) => ({ ...n('document', 'docs/r.md', text), file: 'docs/r.md' });
    const env = p('environments.yaml', 'dev', { reset: null });
    const op = p('api-catalog.yaml', 'op', { environment: 'dev', sources: [{ file: '.\\docs\\r.md' }] });
    const page = p('pages.yaml', 'page', { environment: 'dev', sources: [{ file: 'docs/./r.md' }] });
    const report = analyzeImpact(snap(config, doc('旧'), env, op, page), snap(config, doc('新'), env, op, page), 'abc');
    reason(report, op.key, 'document:docs/r.md', 'current', ['document:docs/r.md', op.key], 'possible');
    reason(report, page.key, 'document:docs/r.md', 'current', ['document:docs/r.md', page.key], 'possible');
  });
  it('更换 actor 和 fixture 时旧新引用分别在对应版本成立', () => {
    const users = [p('auth.yaml', 'old', { kind: 'anonymous', v: 1 }), p('auth.yaml', 'new', { kind: 'anonymous', v: 1 })];
    const fixtures = [p('fixtures.yaml', 'old', { kind: 'command', v: 1 }), p('fixtures.yaml', 'new', { kind: 'command', v: 1 })];
    const base = snap(...users, ...fixtures, clause('A-AC-1'), caseNode('A-TC-1', ['A-AC-1'], 'old', ['old']));
    const current = snap(...[...users, ...fixtures].map((node) => ({ ...node, value: { ...node.value as object, v: 2 } })), clause('A-AC-1'), caseNode('A-TC-1', ['A-AC-1'], 'new', ['new']));
    const report = analyzeImpact(base, current, 'abc');
    for (const kind of ['auth', 'fixtures']) for (const [side, id] of [['base', 'old'], ['current', 'new']] as const) {
      const source = `profile:${kind}.yaml:${id}`;
      reason(report, 'case:A-TC-1', source, side, [source, 'case:A-TC-1']);
      expect(impact(report, 'case:A-TC-1')?.reasons.some((r) => r.source === source && r.side !== side && r.certainty === 'definite')).toBe(false);
    }
  });
  it('重复和缺失引用产生诊断，invalid 不制造删除', () => {
    const old = snap(clause('A-AC-1'), caseNode('A-TC-1', ['A-AC-1']), actor());
    const now = snap(caseNode('A-TC-1', ['missing'], 'absent'), caseNode('A-TC-1', ['missing'], 'absent'));
    now.files.push({ file: 'clauses/test.yaml', state: 'invalid' });
    now.diagnostics.push({ code: 'invalid', message: '无效' });
    const report = analyzeImpact(old, now, 'abc');
    expect(report.complete).toBe(false);
    expect(report.diagnostics.length).toBeGreaterThanOrEqual(3);
    expect(report.changes.some((change) => change.key === 'clause:A-AC-1')).toBe(false);
  });
});
