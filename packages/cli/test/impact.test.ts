import { afterEach, expect, it, vi } from 'vitest';
import { execFile, type ChildProcess } from 'node:child_process';

// 只观察真实子进程句柄，不替换 Git 行为，便于验证取消后的关闭顺序。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ImpactReport } from '@crosscheck/core';
import * as core from '@crosscheck/core';
import { cliMain } from '../src/main';
import { formatImpactText, projectImpactReport } from '../src/impact/report';
import { createSlashDispatcher } from '../src/session';
import { cleanupImpactRepos, impactPut as put, impactRepo as repo, impactRoots } from './impact-test-helper';

afterEach(cleanupImpactRepos);
const clause = (id = 'M-AC-1', text = '原始条款') => ({ id, text, source: { file: 'doc.md', line: 1, excerpt: '不应输出的摘录' } });
const testCase = (id: string, covers: string[]) => ({ id, covers, actor: 'guest', steps: ['不应输出的步骤'], expectations: [{ id: 'E1', text: '不应输出的预期', evidence: ['dom'] }] });
async function project() {
  const result = await repo();
  await put(result.root, '.crosscheck/config.yaml', 'requirementsDocs: [doc.md]');
  await put(result.root, 'doc.md', '不应输出的文档');
  await put(result.root, '.crosscheck/notes.md', '# 不应输出的项目笔记');
  const profiles: Record<string, unknown> = {
    'environments.yaml': { version: 1, environments: {} }, 'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } },
    'api-catalog.yaml': { version: 1, operations: {} }, 'pages.yaml': { version: 1, pages: {} },
    'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: {} }, 'guardrails.yaml': { allowedHosts: ['localhost'] },
  };
  for (const [name, value] of Object.entries(profiles)) await put(result.root, `.crosscheck/system/${name}`, JSON.stringify(value));
  await put(result.root, '.crosscheck/requirements/M.yaml', JSON.stringify([clause(), clause('M-AC-2')]));
  await put(result.root, '.crosscheck/cases/M.yaml', JSON.stringify([testCase('M-TC-1', ['M-AC-1']), testCase('M-TC-2', ['M-AC-2'])]));
  result.git('add', '.'); result.git('commit', '-m', '初始');
  return result;
}
async function run(root: string, flags: string[] = [], signal?: AbortSignal) {
  const lines: string[] = [];
  // 访问模型配置即抛错，确保命令完全绕开模型与用户配置路径。
  const dependencies = Object.defineProperty({}, 'modelOptions', { get() { throw new Error('不能加载模型'); } });
  const code = await cliMain(['impact', '--project', root, '--json', ...flags], { log: (s) => lines.push(s), dependencies, signal });
  expect(lines).toHaveLength(1);
  const report = JSON.parse(lines[0]!) as ImpactReport;
  expect(Object.keys(report).sort()).toEqual(['advisories', 'baseline', 'changes', 'complete', 'diagnostics', 'impacts', 'limitations', 'version']);
  expect(report.version).toBe(1);
  return { code, report, output: lines[0]! };
}
async function bytes(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await bytes(root, name));
    else result[name] = (await readFile(path.join(root, name))).toString('base64');
  }
  return result;
}

it('CLI 投影裁剪后按公开完整性退出二，不保留分析阶段退出零', async () => {
  const { root } = await project();
  // 仅替换纯分析结果以隔离投影边界；真实临时仓库、命令、投影和退出码全部执行。
  const analyzer = vi.spyOn(core, 'analyzeImpact').mockReturnValue({ version: 1, baseline: 'a'.repeat(40), complete: true, changes: Array.from({ length: 100 }, (_, i) => ({ key: `document:${i}-${'؜'.repeat(10000)}`, kind: 'added', fields: ['/'] })), impacts: [], diagnostics: [], advisories: [], limitations: [] });
  try {
    const { code, report } = await run(root);
    expect(report.complete).toBe(false);
    expect(code).toBe(2);
  } finally { analyzer.mockRestore(); }
});
it('公开投影转义与附加建议后仍限制总输出，固定诊断令结果不完整', () => {
  const report: ImpactReport = { version: 1, baseline: 'a'.repeat(40), complete: true, changes: Array.from({ length: 100 }, (_, i) => ({ key: `document:${i}-${'؜'.repeat(10000)}`, kind: 'added', fields: ['/'] })), impacts: [], diagnostics: [], advisories: [], limitations: [] };
  const projected = projectImpactReport(report);
  expect(projected.complete).toBe(false);
  expect(JSON.stringify(projected).length).toBeLessThanOrEqual(2000000);
  expect(projected.diagnostics).toContainEqual({ code: 'analysis-limit', message: '分析或输出达到资源上限，结果已截断，请缩小范围复核' });
});
it('每个真实 Git 子进程固定禁用惰性获取，partial 输入只输出单对象退出二且不解析对象', async () => {
  const { root, git } = await project();
  git('config', 'remote.origin.promisor', 'true');
  const spy = vi.mocked(execFile); spy.mockClear();
  const { code, report } = await run(root);
  expect(code).toBe(2); expect(report.complete).toBe(false);
  expect(spy.mock.calls.some((call) => (call[1] as string[]).includes('cat-file'))).toBe(false);
  expect(spy.mock.calls.some((call) => (call[1] as string[]).includes('--verify'))).toBe(false);
  for (const call of spy.mock.calls) expect((call[2] as { env: NodeJS.ProcessEnv }).env.GIT_NO_LAZY_FETCH).toBe('1');
});
it('六千缺失文档的 Git 查询与 JSON 报告有界，不把截断当无影响', async () => {
  const { root } = await project();
  await put(root, '.crosscheck/config.yaml', JSON.stringify({ requirementsDocs: Array.from({ length: 6000 }, (_, i) => `missing-${i}.md`) }));
  const spy = vi.mocked(execFile); spy.mockClear();
  const { code, report, output } = await run(root);
  expect(code).toBe(2); expect(report.complete).toBe(false);
  expect(report.diagnostics.some((d) => d.code === 'file-limit')).toBe(true);
  expect(spy.mock.calls.length).toBeLessThan(100);
  expect(output.length).toBeLessThan(2000000);
  expect(report.diagnostics.some((d) => d.file === 'missing-5999.md')).toBe(false);
  expect(report.advisories.join(' ')).not.toContain('活动条款未被用例覆盖');
});
it('失效用例模块不宣称跨模块条款未覆盖，合法无用例目录仍可判定空覆盖', async () => {
  const { root, git } = await project();
  await put(root, '.crosscheck/cases/N.yaml', '[无效秘密');
  const invalid = await run(root);
  expect(invalid.code).toBe(2);
  expect(invalid.report.advisories.join('\n')).toContain('覆盖无法确认');
  expect(invalid.report.advisories.join('\n')).not.toContain('活动条款未被用例覆盖');
  await rm(path.join(root, '.crosscheck/cases'), { recursive: true });
  git('add', '.'); git('commit', '-m', '无用例目录');
  const empty = await run(root);
  expect(empty.code).toBe(0);
  expect(empty.report.advisories).toContain('活动条款未被用例覆盖：clause:M-AC-1');
});
it('完整项目只读比较磁盘条款，确定影响只包含 covers 用例且非空仍退出零', async () => {
  const { root, git } = await project();
  await put(root, '.crosscheck/requirements/M.yaml', JSON.stringify([clause('M-AC-1', '修改后的秘密条款'), clause('M-AC-2')]));
  const before = await bytes(root), status = git('status', '--porcelain=v1', '-uall');
  const { code, report, output } = await run(root);
  expect(code).toBe(0); expect(report.complete).toBe(true);
  expect(report.baseline).toBe(git('rev-parse', 'HEAD').toString().trim());
  expect(report.changes).toEqual([{ key: 'clause:M-AC-1', kind: 'modified', fields: ['/text'] }]);
  expect(report.impacts).toEqual([{ key: 'case:M-TC-1', certainty: 'definite', reasons: [
    { source: 'clause:M-AC-1', chain: ['clause:M-AC-1', 'case:M-TC-1'], certainty: 'definite', side: 'base' },
    { source: 'clause:M-AC-1', chain: ['clause:M-AC-1', 'case:M-TC-1'], certainty: 'definite', side: 'current' },
  ] }]);
  expect(output).not.toContain('秘密条款'); expect(output).not.toContain('不应输出');
  expect((await run(root)).output).toBe(output);
  expect(await bytes(root)).toEqual(before); expect(git('status', '--porcelain=v1', '-uall')).toEqual(status);
});
it('新增条款不会影响不 covers 的既有用例，建议核对 reqs 和 plan', async () => {
  const { root } = await project();
  await put(root, '.crosscheck/requirements/M.yaml', JSON.stringify([clause(), clause('M-AC-2'), clause('M-AC-3')]));
  const { code, report } = await run(root);
  expect(code).toBe(0); expect(report.impacts).toEqual([]);
  expect(report.changes).toEqual([{ key: 'clause:M-AC-3', kind: 'added', fields: ['/'] }]);
  expect(report.advisories.join('\n')).toContain('reqs'); expect(report.advisories.join('\n')).toContain('plan');
});
it('notes 变化对画像和用例保持可能影响并建议 profile 人工复核', async () => {
  const { root } = await project(); await put(root, '.crosscheck/notes.md', '# 更新的秘密笔记');
  const { code, report, output } = await run(root);
  expect(code).toBe(0); expect(report.impacts.length).toBeGreaterThan(0);
  expect(report.impacts.every((item) => item.certainty === 'possible')).toBe(true);
  expect(report.impacts.flatMap((item) => item.reasons).every((reason) => reason.description === '项目笔记未记录结构化来源依赖，需人工复核。')).toBe(true);
  expect(report.advisories.join('\n')).toContain('profile'); expect(output).not.toContain('秘密笔记');
  for (const file of ['environments.yaml', 'auth.yaml', 'api-catalog.yaml', 'pages.yaml', 'data-model.yaml', 'fixtures.yaml', 'guardrails.yaml']) expect(report.advisories.join('\n')).toContain(file);
});
it('需求文档变化只有可能来源关联，不把映射当作确定失败', async () => {
  const { root } = await project(); await put(root, 'doc.md', '变化的秘密文档');
  const { code, report, output } = await run(root);
  expect(code).toBe(0); expect(report.impacts).toContainEqual(expect.objectContaining({ key: 'case:M-TC-1', certainty: 'possible' }));
  expect(report.impacts.every((item) => item.certainty === 'possible')).toBe(true);
  expect(output).not.toContain('秘密文档'); expect(report.limitations.join('\n')).toContain('不表示用例必然失败');
});
it.each(['数量', '类型', '连接'])('七画像聚合校验 SQL fixture %s 错误，保留节点和其他变更且脱敏', async (mode) => {
  const { root } = await project();
  await put(root, '.crosscheck/system/data-model.yaml', JSON.stringify({ version: 1, connection: { kind: 'postgres', env: 'READ_SECRET' }, queries: { q: { sql: 'SQL_SECRET', parameters: [{ name: 'PARAM_SECRET', type: 'number' }] } } }));
  await put(root, '.crosscheck/system/fixtures.yaml', JSON.stringify({ version: 1, fixtures: { setup: { kind: 'sql', query: 'q', params: mode === '数量' ? [] : mode === '类型' ? ['VALUE_SECRET'] : [1], connection: { kind: 'postgres', env: mode === '连接' ? 'READ_SECRET' : 'WRITE_SECRET' } } } }));
  await put(root, '.crosscheck/requirements/M.yaml', JSON.stringify([clause('M-AC-1', '修改'), clause('M-AC-2')]));
  const { code, report, output } = await run(root);
  expect(code).toBe(2); expect(report.complete).toBe(false);
  expect(report.diagnostics).toContainEqual({ code: 'invalid-profile', side: 'current', message: '七画像跨文件校验失败，请复核引用、参数及连接配置' });
  expect(report.changes).toContainEqual({ key: 'clause:M-AC-1', kind: 'modified', fields: ['/text'] });
  expect(report.changes).toContainEqual(expect.objectContaining({ key: 'profile:fixtures.yaml:setup' }));
  for (const secret of ['READ_SECRET', 'WRITE_SECRET', 'SQL_SECRET', 'PARAM_SECRET', 'VALUE_SECRET']) expect(output).not.toContain(secret);
});
it('文档仅关联 operation/page 且条款来自其他文档时仍逐侧传播到自然语言用例', async () => {
  const { root, git } = await project();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [doc.md, api.md]');
  await put(root, 'api.md', '旧 API 文档');
  await put(root, '.crosscheck/system/environments.yaml', JSON.stringify({ version: 1, environments: { dev: { baseURL: 'http://localhost', healthcheck: 'http://localhost', reset: null } } }));
  const source = { file: 'api.md', line: 1, excerpt: '来源秘密' };
  await put(root, '.crosscheck/system/api-catalog.yaml', JSON.stringify({ version: 1, operations: { op: { environment: 'dev', method: 'GET', path: '/', description: '操作秘密', sources: [source] } } }));
  await put(root, '.crosscheck/system/pages.yaml', JSON.stringify({ version: 1, pages: { home: { environment: 'dev', path: '/', description: '页面秘密', sources: [source] } } }));
  git('add', '.'); git('commit', '-m', '来源基线');
  await put(root, 'api.md', '新 API 文档');
  // current 删除来源，仅 base 的保守链应成立，不允许跨侧拼接。
  await put(root, '.crosscheck/system/api-catalog.yaml', JSON.stringify({ version: 1, operations: {} }));
  const { code, report } = await run(root);
  expect(code).toBe(0);
  const reasons = report.impacts.find((i) => i.key === 'case:M-TC-1')?.reasons ?? [];
  expect(reasons).toContainEqual(expect.objectContaining({ source: 'document:api.md', side: 'base', certainty: 'possible', chain: ['document:api.md', 'profile:api-catalog.yaml:op', 'case:M-TC-1'] }));
  expect(reasons).toContainEqual(expect.objectContaining({ source: 'document:api.md', side: 'current', certainty: 'possible', chain: ['document:api.md', 'profile:pages.yaml:home', 'case:M-TC-1'] }));
  expect(reasons.some((r) => r.source === 'document:api.md' && r.side === 'current' && r.chain.includes('profile:api-catalog.yaml:op'))).toBe(false);
});
it('合法七画像空操作目录仍能完整分析', async () => {
  const { root } = await project(); const { code, report } = await run(root);
  expect(code).toBe(0); expect(report.complete).toBe(true); expect(report.changes).toEqual([]); expect(report.diagnostics).toEqual([]);
});
it('尊重 since 历史提交，不读取暂存内容作为目标', async () => {
  const { root, git } = await project();
  await put(root, '.crosscheck/requirements/M.yaml', JSON.stringify([clause('M-AC-1', '暂存条款'), clause('M-AC-2')])); git('add', '.'); git('commit', '-m', '第二版');
  await put(root, '.crosscheck/requirements/M.yaml', JSON.stringify([clause(), clause('M-AC-2')]));
  expect((await run(root, ['--since', 'HEAD~1'])).report.changes).toEqual([]);
});
it.each(['body', 'params'])('JSON 与文本都屏蔽 %s 任意嵌套属性键及值', async (field) => {
  const { root, git } = await project();
  const secret = 'SECRET_SENTINEL_DYNAMIC_SECRET_829761/\u001b[31m';
  const fixture = (value: number) => field === 'body'
    ? { kind: 'http', operation: 'op', body: { safe: { [secret]: value }, text: `VALUE_SECRET_${value}` } }
    : { kind: 'sql', query: 'q', params: [{ safe: [{ [secret]: value }], text: `VALUE_SECRET_${value}` }], connection: { kind: 'postgres', env: 'WRITE_DB' } };
  await put(root, '.crosscheck/system/fixtures.yaml', JSON.stringify({ version: 1, fixtures: { setup: fixture(1) } }));
  git('add', '.'); git('commit', '-m', '动态键基线');
  await put(root, '.crosscheck/system/fixtures.yaml', JSON.stringify({ version: 1, fixtures: { setup: fixture(2) } }));
  const { report, output } = await run(root);
  expect(report.changes).toEqual([{ key: 'profile:fixtures.yaml:setup', kind: 'modified', fields: [`/${field}`] }]);
  expect(output).not.toContain('DYNAMIC_SECRET'); expect(output).not.toContain('VALUE_SECRET');
  const lines: string[] = []; await cliMain(['impact', '--project', root], { log: (s) => lines.push(s) });
  expect(lines.join('\n')).not.toContain('DYNAMIC_SECRET'); expect(lines.join('\n')).not.toContain('VALUE_SECRET');
});
it.each([
  { field: 'forbidden', count: 4000, sides: ['base'] as const },
  { field: 'redactFields', count: 2000, sides: ['base', 'current'] as const },
])('$field 大字段列表不随每条原因重复，保留全部字段及原因关联', ({ field, count, sides }) => {
  const source = 'profile:guardrails.yaml:global';
  const fields = Array.from({ length: count }, (_, i) => field === 'forbidden' ? `/forbidden/${i}/path` : `/redactFields/${i}`);
  const report: ImpactReport = {
    version: 1, baseline: 'a'.repeat(40), complete: true,
    changes: [{ key: source, kind: 'modified', fields }],
    impacts: Array.from({ length: 400 }, (_, i) => ({
      key: `case:M-TC-${i}`, certainty: 'possible' as const,
      reasons: sides.map((side) => ({ source, side, certainty: 'possible' as const,
        chain: [source, `case:M-TC-${i}`], description: '全局安全条件发生变化，需复核用例。' })),
    })),
    diagnostics: [], advisories: [], limitations: [],
  };
  const projected = projectImpactReport(report);
  expect(projected.complete).toBe(true);
  expect(JSON.stringify(projected).length).toBeLessThan(2000000);
  const rendered = formatImpactText(projected);
  expect(rendered.length).toBeLessThan(2000000);
  const changeLine = rendered.split('\n').find((line) => line.startsWith(`  ${source} modified 字段 `));
  expect(changeLine).toBe(`  ${source} modified 字段 ${[...fields].sort().join(', ')} [base/current]`);
  expect(rendered.split(' 字段 ')).toHaveLength(2);
  for (let i = 0; i < 400; i++) {
    for (const side of sides) expect(rendered).toContain(`[${side}/possible] 来源 ${source} 链 ${source} -> case:M-TC-${i}；全局安全条件发生变化，需复核用例。`);
  }
});
it('文本包含基线、目标、分组及实际变更字段和两侧来源链，不输出原文', async () => {
  const { root, git } = await project(); await put(root, '.crosscheck/requirements/M.yaml', JSON.stringify([clause('M-AC-1', '秘密条款'), clause('M-AC-2')]));
  const lines: string[] = []; expect(await cliMain(['impact', '--project', root], { log: (s) => lines.push(s) })).toBe(0);
  const text = lines.join('\n');
  for (const label of ['基线', git('rev-parse', 'HEAD').toString().trim(), '当前磁盘', '实际变更', '显式依赖影响', '可能影响', '缺口', '建议', '限制', 'clause:M-AC-1', '/text', 'base', 'current', 'clause:M-AC-1 -> case:M-TC-1', 'review']) expect(text).toContain(label);
  expect(text).not.toContain('秘密条款'); expect(text).not.toContain('不应输出');
});
it.each(['invalid', 'history'])('损坏或缺历史输入 %s 返回不完整受控报告', async (mode) => {
  const { root } = await project();
  if (mode === 'invalid') await put(root, '.crosscheck/requirements/M.yaml', '[BAD_SECRET_YAML');
  else await put(root, '.crosscheck/cases/N.yaml', '[]');
  const { code, report, output } = await run(root);
  expect(code).toBe(2); expect(report.complete).toBe(false);
  expect(report.diagnostics.some((d) => d.code === (mode === 'invalid' ? 'invalid-file' : 'history-incomplete'))).toBe(true);
  expect(output).not.toContain('BAD_SECRET');
});
it('无效 ref 不回显原始输入，基线留空', async () => {
  const { root } = await project(); const secret = 'BAD_REF_SECRET_123'; const { code, report, output } = await run(root, ['--since', secret]);
  expect(code).toBe(2); expect(report).toMatchObject({ baseline: '', complete: false, changes: [], impacts: [] }); expect(output).not.toContain(secret);
});
it('非 Git 项目和无提交仓库返回单对象退出二', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'impact 非git ')); impactRoots.push(root);
  expect((await run(root)).code).toBe(2);
  const empty = await repo(); expect((await run(empty.root)).code).toBe(2);
});
it('真实 Git 元数据损坏是宿主错误三，不暴露内部异常', async () => {
  const { root } = await project(); await put(root, '.git/HEAD', 'CORRUPT_SECRET_METADATA');
  const { code, report, output } = await run(root);
  expect(code).toBe(3); expect(report.complete).toBe(false); expect(output).not.toContain('CORRUPT_SECRET');
});
it('取消前和执行中都等待清理再输出受控报告并恢复监听器', async () => {
  const { root } = await project();
  for (const pre of [true, false]) {
    const controller = new AbortController(); const count = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    if (pre) controller.abort();
    const pending = run(root, [], controller.signal);
    if (!pre) controller.abort();
    const { code, report } = await pending;
    expect(code).toBe(2); expect(report.complete).toBe(false);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(count);
  }
});
it('/impact 经默认 CLI 路径分发，无需模型或审核会话', async () => {
  const { root } = await project();
  const result = await createSlashDispatcher({})(['impact', '--json', '--project', root], new AbortController().signal);
  expect(result).toMatchObject({ kind: 'log', code: 0 });
  if (result.kind !== 'log') throw new Error('应输出报告');
  expect(result.lines).toHaveLength(1); expect(JSON.parse(result.lines[0]!)).toMatchObject({ version: 1, complete: true });
});
it('SIGINT 中止 Git 读取后诊断为 cancelled，且仅输出单对象', async () => {
  const { root } = await project();
  const controller = new AbortController();
  const counts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const pending = run(root, [], controller.signal);
  // impact 已同步安装监听器；发出事件，不向测试进程发送操作系统信号。
  process.emit('SIGINT');
  const { code, report } = await pending;
  expect(controller.signal.aborted).toBe(false);
  expect(code).toBe(2); expect(report.diagnostics).toEqual([{ code: 'cancelled', message: '分析已取消' }]);
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(counts);
});
it('真实 Git 子进程收到取消并关闭后才输出 JSON，监听器完整清理', async () => {
  const { root } = await project();
  const controller = new AbortController();
  const spy = vi.mocked(execFile); spy.mockClear();
  const counts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const lines: string[] = [];
  let closed = false, closedAtOutput = false;
  try {
    const pending = cliMain(['impact', '--json', '--project', root], { signal: controller.signal, log: (line) => {
      closedAtOutput = closed; lines.push(line);
    } });
    const deadline = Date.now() + 5000;
    while (!spy.mock.results.length && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve));
    const child = spy.mock.results[0]?.value as ChildProcess | undefined;
    expect(child?.pid).toBeDefined();
    child!.once('close', () => { closed = true; });
    controller.abort();
    expect(await pending).toBe(2);
    expect(closedAtOutput).toBe(true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ complete: false, diagnostics: [{ code: 'cancelled' }] });
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(counts);
  } finally { controller.abort(); spy.mockClear(); }
});
it('安全限制变化保留真实 schema 字段路径而不输出限制值', async () => {
  const { root, git } = await project();
  const value = (suffix: string) => ({ allowedHosts: ['localhost'], forbidden: [{ method: 'POST', path: `SECRET_PATH_${suffix}` }], redactFields: [`SECRET_FIELD_${suffix}`], screenshotMasks: [`SECRET_MASK_${suffix}`] });
  await put(root, '.crosscheck/system/guardrails.yaml', JSON.stringify(value('OLD'))); git('add', '.'); git('commit', '-m', '限制基线');
  await put(root, '.crosscheck/system/guardrails.yaml', JSON.stringify(value('NEW')));
  const { report, output } = await run(root);
  expect(report.changes).toEqual([{ key: 'profile:guardrails.yaml:global', kind: 'modified', fields: ['/forbidden/0/path', '/redactFields/0', '/screenshotMasks/0'] }]);
  expect(output).not.toContain('SECRET_');
});
it('配置预算与连接身份保留字段名，文本转义文件标识控制字符', async () => {
  const { root, git } = await project();
  const doc = 'doc‮.md';
  await put(root, doc, '文档秘密');
  await put(root, '.crosscheck/config.yaml', JSON.stringify({ requirementsDocs: ['doc.md', doc], budget: { perCase: { steps: 3, tokens: 100, minutes: 1 } } }));
  await put(root, '.crosscheck/system/data-model.yaml', 'version: 1\nconnection: { kind: postgres, env: OLD_DB }\nqueries: {}');
  git('add', '.'); git('commit', '-m', '配置基线');
  await put(root, '.crosscheck/config.yaml', JSON.stringify({ requirementsDocs: ['doc.md', doc], budget: { perCase: { steps: 4, tokens: 100, minutes: 1 } } }));
  await put(root, '.crosscheck/system/data-model.yaml', 'version: 1\nconnection: { kind: postgres, env: NEW_DB }\nqueries: {}');
  await put(root, doc, '变化的文档秘密');
  const { report, output } = await run(root);
  expect(report.changes).toContainEqual({ key: 'config:project', kind: 'modified', fields: ['/budget/perCase/steps'] });
  expect(report.changes).toContainEqual({ key: 'profile:data-model.yaml:$connection', kind: 'modified', fields: ['/env'] });
  expect(output).not.toContain('NEW_DB'); expect(output).not.toContain('文档秘密');
  const lines: string[] = []; await cliMain(['impact', '--project', root], { log: (s) => lines.push(s) });
  expect(lines.join('\n')).not.toContain('‮'); expect(lines.join('\n')).toContain('doc\\u202e.md');
});
it('真实 Git 文档路径中全部 Bidi_Control 在 JSON 和文本同源转义，正常 Unicode 保留', async () => {
  const { root, git } = await project();
  const codes = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const controls = codes.map((code) => String.fromCharCode(code));
  const normal = '需求 café 😀';
  const docs = controls.map((control, index) => `${normal}-${index}${control}.md`);
  await put(root, '.crosscheck/config.yaml', JSON.stringify({ requirementsDocs: ['doc.md', ...docs] }));
  for (const doc of docs) await put(root, doc, '原始秘密文档');
  git('add', '.'); git('commit', '-m', '方向控制符路径基线');
  for (const doc of docs) await put(root, doc, '变化的秘密文档');
  const { code, report, output } = await run(root);
  expect(code).toBe(0); expect(report.complete).toBe(true);
  const lines: string[] = [];
  expect(await cliMain(['impact', '--project', root], { log: (line) => lines.push(line) })).toBe(0);
  const rendered = lines.join('\n');
  for (const control of controls) {
    expect(output).not.toContain(control);
    expect(rendered).not.toContain(control);
  }
  for (const [index, code] of codes.entries()) {
    const key = `document:${normal}-${index}\\u${code.toString(16).padStart(4, '0')}.md`;
    expect(report.changes).toContainEqual({ key, kind: 'modified', fields: ['/text'] });
    expect(rendered).toContain(key);
  }
  expect(output).toContain(normal); expect(rendered).toContain(normal);
  expect(output).not.toContain('秘密文档'); expect(rendered).not.toContain('秘密文档');
});
it('删除用例不建议审核已不存在的实体', async () => {
  const { root } = await project(); await rm(path.join(root, '.crosscheck/cases/M.yaml'));
  const { report } = await run(root);
  expect(report.changes).toContainEqual({ key: 'case:M-TC-1', kind: 'deleted', fields: ['/'] });
  expect(report.advisories.join('\n')).not.toContain('review case:M-TC-1');
});
