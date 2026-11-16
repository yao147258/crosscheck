import { expect, it } from 'vitest';
import { cliMain, parseArgs } from '../src/main';

it('重复模块/用例保留集合筛选，resume可有无标识', () => {
  expect(parseArgs(['run', '--module', 'M', '--module', 'N', '--case', 'M-TC-1', '--case', 'N-TC-2', '--resume', '--project', 'a', '--environment', 'local'])).toMatchObject({ command: 'run', modules: ['M', 'N'], caseIds: ['M-TC-1', 'N-TC-2'], resume: true, project: 'a', environment: 'local', open: false });
  expect(parseArgs(['run', '--resume', 'saved'])).toMatchObject({ resume: 'saved' });
});
it.each([[], ['run', '--mock-pass'], ['run', '--approve'], ['run', '--case'], ['report'], ['report', '../bad'], ['report', 'id', '--resume'], ['run', '--project', 'a', '--project', 'b'], ['run', 'extra']].map(args => ({ args })))('拒绝错误参数$args', ({ args }) => {
  expect(() => parseArgs(args)).toThrow();
});
it('help不读取项目，参数错误退出2而非成功', async () => {
  const output: string[] = [];
  expect(await cliMain(['--help'], { log: s => output.push(s) })).toBe(0);
  expect(output.join('')).toContain('--resume');
  expect(await cliMain(['run', '--force'], { log: s => output.push(s) })).toBe(2);
});
it('缺输入run不伪造result，错误report退出3', async () => {
  const output: string[] = [];
  expect(await cliMain(['run', '--project', '不存在的项目'], { log: s => output.push(s) })).toBe(2);
  expect(output.join('')).not.toContain('PASS');
  expect(await cliMain(['report', '20261113T123456789Z-00000000000000000000000000000000'], { log: s => output.push(s) })).toBe(3);
});
