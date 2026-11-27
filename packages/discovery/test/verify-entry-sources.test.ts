import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { verifyEntrySources, walkProject } from '../src/index';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'entry-sources-'));
  await mkdir(join(root, 'server'));
  await writeFile(join(root, 'server/users.controller.ts'), "@Controller('users')\nexport class Users {\n  @Get(':id')\n  find() {}\n}\n");
  await writeFile(join(root, '.env'), 'API_TOKEN=real\n');
  await writeFile(join(root, 'server/config.ts'), 'API_KEY=sk-12345678901234567890\n');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const entry = (file: string, line: number, excerpt: string) => ({ sources: [{ file, line, excerpt }] });
async function verify(entries: Record<string, { sources: { file: string; line: number; excerpt: string }[] }>) {
  return verifyEntrySources({ projectRoot: root, files: (await walkProject(root)).files, entries });
}

it('来源行包含摘录则保留，保持原顺序和条目对象', async () => {
  const b = entry('server/users.controller.ts', 3, "@Get(':id')");
  const a = entry('./server\\users.controller.ts', 1, ' @Controller ');
  const result = await verify({ b, a });
  expect(Object.keys(result.kept)).toEqual(['b', 'a']);
  expect(result.kept.b).toBe(b);
  expect(result.kept.a).toBe(a);
  expect(result.dropped).toEqual([]);
});

it('多个来源只要一个通过就保留', async () => {
  const result = await verify({ x: { sources: [{ file: 'server/users.controller.ts', line: 1, excerpt: '虚构' }, { file: 'server/users.controller.ts', line: 3, excerpt: '@Get' }] } });
  expect(Object.keys(result.kept)).toEqual(['x']);
});

it.each([
  ['文件不存在', entry('server/none.ts', 1, 'x')],
  ['行号越界', entry('server/users.controller.ts', 99, '@Get')],
  ['行号为零', entry('server/users.controller.ts', 0, '@Get')],
  ['行号非整数', entry('server/users.controller.ts', 1.5, '@Controller')],
  ['摘录不符', entry('server/users.controller.ts', 2, '@Get')],
  ['路径越出项目', entry('../outside.ts', 1, 'x')],
  ['禁止用父目录段折叠为已登记来源', entry('server/../server/users.controller.ts', 3, '@Get')],
  ['禁止把绝对路径改写为已登记来源', entry('/server/users.controller.ts', 3, '@Get')],
  ['凭证文件不在登记范围', entry('.env', 1, 'API_TOKEN')],
  ['摘录为空', entry('server/users.controller.ts', 1, '   ')],
  ['没有来源', { sources: [] }],
])('%s 时剔除且原因不包含摘录', async (_name, value) => {
  const result = await verify({ bad: value });
  expect(result.kept).toEqual({});
  expect(result.dropped).toEqual([{ name: 'bad', reason: value.sources[0] ? `来源核验失败：${value.sources[0].file}:${value.sources[0].line}` : '来源核验失败' }]);
});

it('已登记文件消失与读取故障分别报告，即使另一个来源通过也不能掩盖故障', async () => {
  const files = (await walkProject(root)).files;
  await rm(join(root, 'server/config.ts'));
  await mkdir(join(root, 'server/config.ts'));
  await writeFile(join(root, 'server/gone.ts'), '临时内容');
  const { files: withGone } = await walkProject(root);
  await rm(join(root, 'server/gone.ts'));
  const result = await verifyEntrySources({
    projectRoot: root, files: [...files, ...withGone.filter((file) => file.path === 'server/gone.ts')],
    entries: {
      mixed: { sources: [...entry('server/users.controller.ts', 3, '@Get').sources, ...entry('server/config.ts', 1, '候选').sources] },
      uncertain: entry('server/config.ts', 1, '另一候选'),
      gone: entry('server/gone.ts', 1, '临时内容'),
    },
  });
  expect(Object.keys(result.kept)).toEqual(['mixed']);
  expect(result.dropped.map(({ name }) => name)).toEqual(['gone']);
  expect(result.unreadable).toEqual(['server/config.ts']);
});

it('清洗函数先于比较生效', async () => {
  const result = await verifyEntrySources({
    projectRoot: root, files: (await walkProject(root)).files,
    entries: { x: entry('server/users.controller.ts', 3, '@Hidden(":id")') },
    clean: (text) => text.replace('@Get', '@Hidden').replace("':id'", '":id"'),
  });
  expect(Object.keys(result.kept)).toEqual(['x']);
});

it('安全且内容匹配的文件未登记时不予保留', async () => {
  const files = (await walkProject(root)).files.filter((file) => file.path !== 'server/users.controller.ts');
  const result = await verifyEntrySources({ projectRoot: root, files, entries: { x: entry('server/users.controller.ts', 1, '@Controller') } });
  expect(result.kept).toEqual({});
  expect(result.dropped).toEqual([{ name: 'x', reason: '来源核验失败：server/users.controller.ts:1' }]);
});

it('最后来源清洗期间取消时不能成功返回', async () => {
  const controller = new AbortController();
  const files = (await walkProject(root)).files;
  await expect(verifyEntrySources({
    projectRoot: root, files, entries: { x: entry('server/users.controller.ts', 1, '@Controller') },
    signal: controller.signal,
    clean: (text) => { controller.abort(); return text; },
  })).rejects.toThrow();
});

it('核验使用脱敏后的内容而不是原始凭证', async () => {
  const result = await verify({ secret: entry('server/config.ts', 1, 'sk-12345678901234567890') });
  expect(result.kept).toEqual({});
  expect(result.dropped[0]?.reason).toBe('来源核验失败：server/config.ts:1');
});

it('自身键 __proto__ 被保留且不修改结果原型', async () => {
  const value = entry('server/users.controller.ts', 1, '@Controller');
  const result = await verify(Object.fromEntries([['__proto__', value]]));
  expect(Object.keys(result.kept)).toEqual(['__proto__']);
  expect(Object.hasOwn(result.kept, '__proto__')).toBe(true);
  expect(result.kept['__proto__']).toBe(value);
  expect(Object.getPrototypeOf(result.kept)).toBe(Object.prototype);
});

const cancelledEntries: Record<string, ReturnType<typeof entry>>[] = [{ x: entry('a', 1, 'a') }, {}];
it.each(cancelledEntries)('预取消时即使输入为空也抛出', async (entries) => {
  await expect(verifyEntrySources({ projectRoot: root, files: [], entries, signal: AbortSignal.abort() })).rejects.toThrow();
});
