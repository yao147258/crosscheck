import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ImpactReport } from '@crosscheck/core';
import { cliMain } from '../src/main';
import { cleanupImpactRepos, impactPut as put, impactRepo as repo } from './impact-test-helper';

afterEach(cleanupImpactRepos);

async function analyze(root: string) {
  const lines: string[] = [];
  // 访问模型配置即抛错，确保 impact 完全不走模型路径。
  const dependencies = Object.defineProperty({}, 'modelOptions', { get() { throw new Error('不能加载模型'); } });
  await cliMain(['impact', '--project', root, '--json'], { log: (s) => lines.push(s), dependencies });
  return JSON.parse(lines[0]!) as ImpactReport;
}
const documentChanges = (report: ImpactReport) =>
  Object.fromEntries(report.changes.filter((change) => change.key.startsWith('document:')).map((change) => [change.key, change.kind]));

it('config 目录写法：目录内新增、修改、删除 .md 都被识别，非 .md 被忽略', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [docs/]');
  await put(root, 'docs/a.md', '甲'); await put(root, 'docs/sub/b.md', '乙'); await put(root, 'docs/sub/ignored.txt', '忽略');
  git('add', '.'); git('commit', '-m', '初始');
  await put(root, 'docs/sub/b.md', '乙改'); await put(root, 'docs/c.md', '丙'); git('add', 'docs/c.md');
  await rm(path.join(root, 'docs', 'a.md'));
  expect(documentChanges(await analyze(root))).toEqual({
    'document:docs/sub/b.md': 'modified', 'document:docs/c.md': 'added', 'document:docs/a.md': 'deleted',
  });
});

it('config 为空时使用笔记的需求文档小节', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: []');
  await put(root, '.crosscheck/notes.md', '# 笔记\n\n## 需求文档\n\n- `docs/` 需求\n');
  await put(root, 'docs/a.md', '甲');
  git('add', '.'); git('commit', '-m', '初始');
  await put(root, 'docs/a.md', '甲改');
  expect(documentChanges(await analyze(root))).toEqual({ 'document:docs/a.md': 'modified' });
});

it('基线中目录尚不存在时不报错，当前新增的文档识别为 added', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [docs/]');
  git('add', '.'); git('commit', '-m', '初始');
  await put(root, 'docs/x.md', '新'); git('add', 'docs/x.md');
  expect(documentChanges(await analyze(root))).toEqual({ 'document:docs/x.md': 'added' });
});

it('目录内文档变化会波及以它为来源的条款', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [docs/]');
  await put(root, 'docs/sub/b.md', '乙');
  await put(root, '.crosscheck/requirements/M.yaml', JSON.stringify([{ id: 'M-AC-1', text: '条款', source: { file: 'docs/sub/b.md', line: 1, excerpt: '乙' } }]));
  git('add', '.'); git('commit', '-m', '初始');
  await put(root, 'docs/sub/b.md', '乙改');
  const report = await analyze(root);
  expect(report.impacts.map((impact) => impact.key)).toContain('clause:M-AC-1');
});
