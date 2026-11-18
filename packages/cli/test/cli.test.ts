import { expect, it } from 'vitest';
import { cliMain, parseArgs } from '../src/main';

it('重复模块/用例保留集合筛选，resume可有无标识', () => {
  expect(parseArgs(['run', '--module', 'M', '--module', 'N', '--case', 'M-TC-1', '--case', 'N-TC-2', '--resume', '--project', 'a', '--environment', 'local'])).toMatchObject({ command: 'run', modules: ['M', 'N'], caseIds: ['M-TC-1', 'N-TC-2'], resume: true, project: 'a', environment: 'local', open: false });
  expect(parseArgs(['run', '--resume', 'saved'])).toMatchObject({ resume: 'saved' });
});
it('无参数解析为会话，非 TTY 时拒绝启动', async () => {
  expect(parseArgs([])).toMatchObject({ command: 'session', project: process.cwd(), open: false });
  const lines: string[] = [];
  expect(await cliMain([], { log: (line) => lines.push(line), dependencies: { session: { isTTY: false } } })).toBe(2);
  expect(lines.join('\n')).toContain('TTY');
});
it.each([['run', '--mock-pass'], ['run', '--approve'], ['run', '--case'], ['report'], ['report', '../bad'], ['report', 'id', '--resume'], ['run', '--project', 'a', '--project', 'b'], ['run', 'extra']].map(args => ({ args })))('拒绝错误参数$args', ({ args }) => {
  expect(() => parseArgs(args)).toThrow();
});
it('help不读取项目，参数错误退出2而非成功', async () => {
  const output: string[] = [];
  expect(await cliMain(['--help'], { log: s => output.push(s) })).toBe(0);
  expect(output.join('')).toContain('--resume');
  expect(await cliMain(['run', '--force'], { log: s => output.push(s) })).toBe(2);
});
it('解析新命令的参数', () => {
  expect(parseArgs(['profile', '--openapi', 'a.yaml', '--openapi', 'b.yaml', '--openapi', 'a.yaml'])).toMatchObject({ command: 'profile', openapi: ['a.yaml', 'b.yaml'] });
  expect(parseArgs(['init', '--refresh'])).toMatchObject({ command: 'init', refresh: true });
  expect(parseArgs(['review', 'notes'])).toMatchObject({ view: 'notes' });
  expect(() => parseArgs(['init', '--openapi', 'a.yaml'])).toThrow();
  expect(parseArgs(['reqs', '--module', 'M09'])).toMatchObject({ command: 'reqs', modules: ['M09'] });
  expect(parseArgs(['plan', '--module', 'M09', '--project', 'p'])).toMatchObject({ command: 'plan', modules: ['M09'], project: 'p' });
  expect(parseArgs(['review'])).toMatchObject({ command: 'review' });
  expect(parseArgs(['review', 'clauses', '--module', 'M09'])).toMatchObject({ command: 'review', view: 'clauses', modules: ['M09'] });
  expect(parseArgs(['review', 'results', '--run', '20261113T123456789Z-00000000000000000000000000000000'])).toMatchObject({ view: 'results', runId: '20261113T123456789Z-00000000000000000000000000000000' });
});
it.each([
  ['reqs'], ['plan'], ['plan', '--module', 'M-1'], ['reqs', '--module', 'A', '--module', 'B'], ['init', '--module', 'M'],
  ['review', 'bogus'], ['review', '--run', 'bad'], ['review', '--case', 'M-TC-1'], ['unknown'],
  ['init', '--openapi'], ['plan', '--module', '../M'], ['review', '--module', 'A', '--module', 'B'],
  ['reqs', '--open'], ['report', '20261113T123456789Z-00000000000000000000000000000000', '--openapi', 'a.yaml'],
].map((args) => ({ args })))('拒绝新命令的错误参数$args', ({ args }) => {
  expect(() => parseArgs(args)).toThrow();
});
it('保留旧命令的合法参数与集合语义', () => {
  expect(parseArgs(['run', '--module', 'M-1', '--module', 'M-1', '--case', 'M-TC-1', '--case', 'M-TC-1', '--open'])).toMatchObject({ modules: ['M-1'], caseIds: ['M-TC-1'], open: true });
  expect(parseArgs(['report', '20261113T123456789Z-00000000000000000000000000000000', '--project', 'p', '--open'])).toMatchObject({ command: 'report', project: 'p', open: true });
});
it('参数错误保留具体子命令与标识提示', async () => {
  const output: string[] = [];
  expect(await cliMain(['reqs'], { log: (s) => output.push(s) })).toBe(2);
  expect(output.join('\n')).toContain('reqs 需要 --module');
  expect(() => parseArgs(['review', '--run', 'bad'])).toThrow('运行标识不合法');
});
it('缺输入run不伪造result，错误report退出3', async () => {
  const output: string[] = [];
  expect(await cliMain(['run', '--project', '不存在的项目'], { log: s => output.push(s) })).toBe(2);
  expect(output.join('')).not.toContain('PASS');
  expect(await cliMain(['report', '20261113T123456789Z-00000000000000000000000000000000'], { log: s => output.push(s) })).toBe(3);
});
