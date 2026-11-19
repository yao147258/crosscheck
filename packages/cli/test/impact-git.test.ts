import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cleanupImpactRepos, impactPut as put, impactRepo as repo, impactRoots as roots } from './impact-test-helper';
import { compareSnapshots } from '@crosscheck/core';
import { loadImpactSnapshots, ImpactHostError, ImpactInputError } from '../src/impact/snapshot';
import { openBaseline } from '../src/impact/git';

afterEach(cleanupImpactRepos);
it.each(['promisor', 'partialClone'])('对象解析前拒绝 %s 仓库，不启动本地 fake helper 或修改对象库', async (mode) => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', '{}'); git('add', '.'); git('commit', '-m', '初始');
  const marker = path.join(root, 'helper-ran');
  await put(root, 'fake-upload-pack', `#!/bin/sh\nprintf invoked > '${marker.replaceAll('\\', '/')}'\nexit 1\n`);
  git('config', 'remote.origin.url', root);
  git('config', 'remote.origin.uploadpack', path.join(root, 'fake-upload-pack').replaceAll('\\', '/'));
  if (mode === 'promisor') git('config', 'remote.origin.promisor', 'true');
  else { git('config', 'core.repositoryFormatVersion', '1'); git('config', 'extensions.partialClone', 'origin'); }
  const before = await readFile(path.join(root, '.git/config'));
  // 使用存在的对象也必须拒绝，证明检测发生在第一次对象解析之前。
  await expect(openBaseline(root, 'HEAD')).rejects.toBeInstanceOf(ImpactInputError);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(root, '.git/config'))).toEqual(before);
});
it('缺失 promisor blob 安全拒绝，不启动 helper、不写对象库', async () => {
  const { root, git } = await repo();
  const missing = 'b'.repeat(40);
  const cross = execFileSync('git', ['mktree', '--missing'], { cwd: root, input: `100644 blob ${missing}\tconfig.yaml\n` }).toString().trim();
  const tree = execFileSync('git', ['mktree'], { cwd: root, input: `040000 tree ${cross}\t.crosscheck\n` }).toString().trim();
  const commit = git('commit-tree', tree, '-m', '缺失对象').toString().trim();
  await put(root, 'fake-upload-pack', '#!/bin/sh\nprintf invoked > helper-ran\nexit 1\n');
  git('config', 'remote.origin.url', root);
  git('config', 'remote.origin.uploadpack', path.join(root, 'fake-upload-pack').replaceAll('\\', '/'));
  git('config', 'remote.origin.promisor', 'true');
  const before = git('count-objects', '-v').toString();
  await expect(loadImpactSnapshots(root, commit)).rejects.toBeInstanceOf(ImpactInputError);
  await expect(readFile(path.join(root, 'helper-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(git('count-objects', '-v').toString()).toBe(before);
});
it('worktree 共享对象库的 promisor 包标记与 alternates 在解析对象前拒绝', async () => {
  const { root, git } = await repo(); await put(root, 'a', 'a'); git('add', '.'); git('commit', '-m', '初始');
  const other = await mkdtemp(path.join(os.tmpdir(), 'impact-shared-')); roots.push(other); git('worktree', 'add', '--detach', other, 'HEAD');
  await put(root, '.git/objects/pack/retained.promisor', '');
  await expect(openBaseline(other, 'HEAD')).rejects.toBeInstanceOf(ImpactInputError);
  await rm(path.join(root, '.git/objects/pack/retained.promisor'));
  await put(root, '.git/objects/info/alternates', '\n');
  await expect(openBaseline(other, 'HEAD')).rejects.toBeInstanceOf(ImpactInputError);
});
it('拒绝带 alternates 的对象库，包括 worktree 共享元数据', async () => {
  const { root, git } = await repo(); await put(root, 'a', 'a'); git('add', '.'); git('commit', '-m', '初始');
  await put(root, '.git/objects/info/alternates', `${root.replaceAll('\\', '/')}/other-objects\n`);
  await expect(openBaseline(root, 'HEAD')).rejects.toBeInstanceOf(ImpactInputError);
});
it('Git 环境仓库重定向与配置注入不会影响被分析项目', async () => {
  const { root, git } = await repo(); await put(root, 'a', 'a'); git('add', '.'); git('commit', '-m', '初始');
  const before = { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 };
  try {
    process.env.GIT_DIR = path.join(root, 'not-a-repo'); process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'remote.inject.promisor'; process.env.GIT_CONFIG_VALUE_0 = 'true';
    expect((await openBaseline(root, 'HEAD')).oid).toBe(gitWithoutEnvironment(root));
  } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
function gitWithoutEnvironment(root: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env }).toString().trim();
}
it('对比提交与真实工作区而非暂存区', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [需求.md]');
  await put(root, '需求.md', '旧内容'); git('add', '.'); git('commit', '-m', '初始');
  await put(root, '需求.md', '暂存内容'); git('add', '.'); await put(root, '需求.md', '磁盘内容');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.base.nodes.find((n) => n.key === 'document:需求.md')?.value).toBe('旧内容');
  expect(result.current.nodes.find((n) => n.key === 'document:需求.md')?.value).toBe('磁盘内容');
  expect(compareSnapshots(result.base, result.current)).toContainEqual({ key: 'document:需求.md', kind: 'modified', fields: ['/text'] });
});
it('文档范围取配置并集，取消登记不虚构删除', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [old.md]'); await put(root, 'old.md', '旧文档');
  git('add', '.'); git('commit', '-m', '初始');
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [new.md]'); await put(root, 'new.md', '新文档');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.nodes.find((n) => n.key === 'document:old.md')?.value).toBe('旧文档');
  expect(compareSnapshots(result.base, result.current)).not.toContainEqual(expect.objectContaining({ key: 'document:old.md', kind: 'deleted' }));
});
it('无效画像不残留连接或查询节点', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}');
  await put(root, '.crosscheck/system/data-model.yaml', 'version: 1\nconnection: { kind: postgres, env: DB_URL }\nqueries:\n  ok: { sql: select 1, parameters: [] }\n  bad: { sql: "", parameters: [] }');
  git('add', '.'); git('commit', '-m', '初始'); const { current } = await loadImpactSnapshots(root, 'HEAD');
  expect(current.files).toContainEqual({ file: '.crosscheck/system/data-model.yaml', state: 'invalid' });
  expect(current.nodes.filter((n) => n.file === '.crosscheck/system/data-model.yaml')).toEqual([]);
});
it('数据库连接与名为 connection 的查询分开', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', '{}');
  await put(root, '.crosscheck/system/data-model.yaml', 'version: 1\nconnection: { kind: postgres, env: DB_URL }\nqueries:\n  connection: { sql: select 1, parameters: [] }');
  git('add', '.'); git('commit', '-m', '初始');
  const { current } = await loadImpactSnapshots(root, 'HEAD');
  expect(current.nodes.filter((n) => n.file.endsWith('data-model.yaml')).map((n) => n.key)).toEqual(['profile:data-model.yaml:$connection', 'profile:data-model.yaml:connection']);
});
it('非法 UTF-8 是 invalid 而非删除', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [doc.md]'); await put(root, 'doc.md', '原文'); git('add', '.'); git('commit', '-m', '初始');
  await put(root, 'doc.md', Uint8Array.from([255]));
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.files).toContainEqual({ file: 'doc.md', state: 'invalid' });
  expect(compareSnapshots(result.base, result.current)).not.toContainEqual(expect.objectContaining({ key: 'document:doc.md' }));
});
it('取消操作归类为输入错误', async () => {
  const { root } = await repo(); const controller = new AbortController(); controller.abort();
  await expect(loadImpactSnapshots(root, 'HEAD', controller.signal)).rejects.toBeInstanceOf(ImpactInputError);
});
it('历史提交使用提交树而非 HEAD', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [doc.md]'); await put(root, 'doc.md', '第一版'); git('add', '.'); git('commit', '-m', '第一版');
  await put(root, 'doc.md', '第二版'); git('add', '.'); git('commit', '-m', '第二版');
  const result = await loadImpactSnapshots(root, 'HEAD~1');
  expect(result.base.nodes.find((n) => n.key === 'document:doc.md')?.value).toBe('第一版');
  expect(result.current.nodes.find((n) => n.key === 'document:doc.md')?.value).toBe('第二版');
});
it('项目配置节点只保留项目投影', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', 'requirementsDocs: []\nmodels: { secret: private-value }\nproviders: { x: { apiKey: private-value } }'); git('add', '.'); git('commit', '-m', '初始');
  const { current } = await loadImpactSnapshots(root, 'HEAD');
  expect(JSON.stringify(current.nodes.find((n) => n.kind === 'config')?.value)).not.toContain('private-value');
});
it('七个合法空画像文件保留 present，且不生成伪实体', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); await put(root, '.crosscheck/notes.md', '# 笔记');
  const files: Record<string, string> = {
    'environments.yaml': 'version: 1\nenvironments: {}', 'auth.yaml': 'version: 1\nactors: {}',
    'api-catalog.yaml': 'version: 1\noperations: {}', 'pages.yaml': 'version: 1\npages: {}',
    'data-model.yaml': 'version: 1\nqueries: {}', 'fixtures.yaml': 'version: 1\nfixtures: {}',
    'guardrails.yaml': 'allowedHosts: [localhost]',
  };
  for (const [name, content] of Object.entries(files)) await put(root, `.crosscheck/system/${name}`, content);
  git('add', '.'); git('commit', '-m', '初始');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.files.filter((f) => f.file.startsWith('.crosscheck/system/') && f.state === 'present')).toHaveLength(7);
  expect(result.current.nodes.filter((n) => n.kind === 'profile').map((n) => n.key)).toEqual(['profile:guardrails.yaml:global']);
  expect(result.current.diagnostics).toEqual([]);
});
it('路径校验在规范化前同时拒绝凭据及路径逃逸', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [safe/../secret.md, .env]'); git('add', '.'); git('commit', '-m', '初始');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.diagnostics.filter((d) => d.code === 'restricted-input')).toHaveLength(2);
  expect(result.current.nodes.filter((n) => n.kind === 'document')).toHaveLength(0);
});
it('单侧无效模块不虚构条款删除', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); await put(root, '.crosscheck/requirements/M01.yaml', '- id: M01-AC-1\n  text: 条款\n  source: { file: doc.md, line: 1, excerpt: 内容 }'); git('add', '.'); git('commit', '-m', '初始');
  await put(root, '.crosscheck/requirements/M01.yaml', '[invalid');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.files).toContainEqual({ file: '.crosscheck/requirements/M01.yaml', state: 'invalid' });
  expect(compareSnapshots(result.base, result.current)).not.toContainEqual(expect.objectContaining({ key: 'clause:M01-AC-1' }));
});
it('目录清单不完整时无法断言另一侧新条款是新增', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); await put(root, '.crosscheck/requirements/M01.yaml', '- id: M01-AC-1\n  text: 条款\n  source: { file: doc.md, line: 1, excerpt: 内容 }'); git('add', '.'); git('commit', '-m', '初始');
  await rm(path.join(root, '.crosscheck/requirements/M01.yaml')); await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(path.join(root, '.crosscheck/requirements', `${i}.txt`), '')));
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.files).toContainEqual({ file: '.crosscheck/requirements', state: 'invalid' });
  expect(compareSnapshots(result.current, result.base)).not.toContainEqual(expect.objectContaining({ key: 'clause:M01-AC-1', kind: 'added' }));
}, 60000);
it('模块目录清单超限时不能报告历史条款被删除', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); await put(root, '.crosscheck/requirements/M01.yaml', '- id: M01-AC-1\n  text: 条款\n  source: { file: doc.md, line: 1, excerpt: 内容 }'); git('add', '.'); git('commit', '-m', '初始');
  await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(path.join(root, '.crosscheck/requirements', `${i}.txt`), '')));
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.files).toContainEqual({ file: '.crosscheck/requirements/M01.yaml', state: 'invalid' });
  expect(compareSnapshots(result.base, result.current)).not.toContainEqual(expect.objectContaining({ key: 'clause:M01-AC-1', kind: 'deleted' }));
}, 60000);
it('历史没有交叉检查工件时标记基线范围缺口', async () => {
  const { root, git } = await repo(); await put(root, 'readme', '初始'); git('add', '.'); git('commit', '-m', '初始');
  await put(root, '.crosscheck/config.yaml', '{}');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.base.diagnostics).toContainEqual(expect.objectContaining({ code: 'missing-config', file: '.crosscheck/config.yaml' }));
});
it('非法模块名即使空数组也必须诊断', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); await put(root, '.crosscheck/requirements/bad name.yaml', '[]'); git('add', '.'); git('commit', '-m', '初始');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.files).toContainEqual({ file: '.crosscheck/requirements/bad name.yaml', state: 'invalid' });
});
it('取消前不遗留未完成的 Git 子进程', async () => {
  const { root, git } = await repo(); await put(root, 'a', 'a'); git('add', '.'); git('commit', '-m', '初始');
  const controller = new AbortController(); controller.abort();
  await expect(loadImpactSnapshots(root, 'HEAD', controller.signal)).rejects.toBeInstanceOf(ImpactInputError);
});
it('模块 ID 与文件名不符时整个文件无效', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); await put(root, '.crosscheck/requirements/M01.yaml', '- id: M02-AC-1\n  text: 内容\n  source: { file: doc.md, line: 1, excerpt: 文本 }'); git('add', '.'); git('commit', '-m', '初始');
  const { current } = await loadImpactSnapshots(root, 'HEAD');
  expect(current.files).toContainEqual({ file: '.crosscheck/requirements/M01.yaml', state: 'invalid' });
  expect(current.nodes.filter((n) => n.kind === 'clause')).toEqual([]);
});
it('模块正常新增删除保持 missing 状态', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); await put(root, '.crosscheck/requirements/M01.yaml', '- id: M01-AC-1\n  text: 条款\n  source: { file: doc.md, line: 1, excerpt: 内容 }'); git('add', '.'); git('commit', '-m', '初始');
  await rm(path.join(root, '.crosscheck/requirements/M01.yaml')); await put(root, '.crosscheck/requirements/M02.yaml', '- id: M02-AC-1\n  text: 新条款\n  source: { file: doc.md, line: 1, excerpt: 内容 }');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(compareSnapshots(result.base, result.current)).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'clause:M01-AC-1', kind: 'deleted' }), expect.objectContaining({ key: 'clause:M02-AC-1', kind: 'added' })]));
});
it('被忽略的画像文件仍被读取并诊断历史不完整', async () => {
  const { root, git } = await repo(); await put(root, '.gitignore', '.crosscheck/system/\n'); await put(root, '.crosscheck/config.yaml', '{}'); git('add', '.'); git('commit', '-m', '初始');
  await put(root, '.crosscheck/system/auth.yaml', 'version: 1\nactors: { anonymous: { kind: anonymous } }');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.nodes).toContainEqual(expect.objectContaining({ key: 'profile:auth.yaml:anonymous' }));
  expect(result.base.diagnostics).toContainEqual(expect.objectContaining({ code: 'history-incomplete', file: '.crosscheck/system/auth.yaml' }));
});
it('读取期间文档内容改变会诊断并发变化', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [doc.md]'); await put(root, 'doc.md', 'old'); git('add', '.'); git('commit', '-m', '初始');
  const result = await loadImpactSnapshots(root, 'HEAD', undefined, { beforeRecheck: () => put(root, 'doc.md', 'new') });
  expect(result.current.diagnostics).toContainEqual(expect.objectContaining({ code: 'concurrent-change', file: 'doc.md' }));
});
it('失去需求模块目录不虚构所有用例删除', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); await put(root, '.crosscheck/requirements/M01.yaml', '- id: M01-AC-1\n  text: 条款\n  source: { file: doc.md, line: 1, excerpt: 内容 }'); git('add', '.'); git('commit', '-m', '初始');
  await rm(path.join(root, '.crosscheck/requirements'), { recursive: true }); await put(root, '.crosscheck/requirements', '不是目录');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.files).toContainEqual({ file: '.crosscheck/requirements/M01.yaml', state: 'invalid' });
  expect(compareSnapshots(result.base, result.current)).not.toContainEqual(expect.objectContaining({ key: 'clause:M01-AC-1', kind: 'deleted' }));
});
it('画像和模块累计超过每侧 16 MiB 时拒绝继续读取', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}');
  const record = `[]\n# ${'a'.repeat(900000)}`;
  for (let i = 0; i < 19; i++) await put(root, `.crosscheck/requirements/M${String(i).padStart(2, '0')}.yaml`, record);
  git('add', '.'); git('commit', '-m', '初始');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.base.files).toContainEqual({ file: '.crosscheck/requirements/M18.yaml', state: 'invalid' });
  expect(result.current.files).toContainEqual({ file: '.crosscheck/requirements/M18.yaml', state: 'invalid' });
}, 60000);
it('超大文件产生受限诊断，不构造删除', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [doc.md]'); await put(root, 'doc.md', '正文'); git('add', '.'); git('commit', '-m', '初始');
  await put(root, 'doc.md', 'x'.repeat(1024 * 1024 + 1));
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.files).toContainEqual({ file: 'doc.md', state: 'invalid' });
  expect(compareSnapshots(result.base, result.current)).not.toContainEqual(expect.objectContaining({ key: 'document:doc.md' }));
});
it('拒绝不存在或尚无提交的基线与非仓库', async () => {
  const { root, git } = await repo(); await expect(loadImpactSnapshots(root, 'HEAD')).rejects.toBeInstanceOf(ImpactInputError);
  await put(root, 'a', 'a'); git('add', '.'); git('commit', '-m', '初始');
  await expect(loadImpactSnapshots(root, 'no-such-ref')).rejects.toBeInstanceOf(ImpactInputError);
  const nonrepo = await mkdtemp(path.join(os.tmpdir(), 'impact-not-repo-')); roots.push(nonrepo);
  await expect(loadImpactSnapshots(nonrepo, 'HEAD')).rejects.toBeInstanceOf(ImpactInputError);
});
it('目录超过条目上限产生受限诊断', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); git('add', '.'); git('commit', '-m', '初始');
  await mkdir(path.join(root, '.crosscheck/cases'), { recursive: true });
  await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(path.join(root, '.crosscheck/cases', `${i}.txt`), '')));
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.diagnostics).toContainEqual(expect.objectContaining({ code: 'restricted-input', file: '.crosscheck/cases' }));
}, 60000);
it('当前符号链接作为受限输入而不是文档删除', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [doc.md]'); await put(root, 'doc.md', '正文'); git('add', '.'); git('commit', '-m', '初始');
  await rm(path.join(root, 'doc.md')); await symlink(path.join(root, '.crosscheck/config.yaml'), path.join(root, 'doc.md'), 'file');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.files).toContainEqual({ file: 'doc.md', state: 'invalid' });
  expect(compareSnapshots(result.base, result.current)).not.toContainEqual(expect.objectContaining({ key: 'document:doc.md' }));
});
it('项目之外的大量树记录不消耗项目清单预算', async () => {
  const { root, git } = await repo();
  await put(root, 'project/.crosscheck/config.yaml', '{}');
  const lines: string[] = []; for (let i = 0; i < 18000; i++) lines.push(`100644 blob ${'a'.repeat(40)}\t${i.toString().padStart(5, '0')}-${'x'.repeat(900)}`);
  // 使用 Git 自身构造大量无关树条目，避免创建大量工作区文件。
  const blob = git('hash-object', '-w', '--stdin').toString().trim();
  const tree = execFileSync('git', ['mktree', '--missing'], { cwd: root, input: lines.map((s) => s.replace('a'.repeat(40), blob)).join('\n') + '\n' }).toString().trim();
  const projectBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: '{}' }).toString().trim();
  const crossTree = execFileSync('git', ['mktree'], { cwd: root, input: `100644 blob ${projectBlob}\tconfig.yaml\n` }).toString().trim();
  const projectTree = execFileSync('git', ['mktree'], { cwd: root, input: `040000 tree ${crossTree}\t.crosscheck\n` }).toString().trim();
  const fullTree = execFileSync('git', ['mktree'], { cwd: root, input: `040000 tree ${tree}\tother\n040000 tree ${projectTree}\tproject\n` }).toString().trim();
  const commit = execFileSync('git', ['commit-tree', fullTree, '-m', '树'], { cwd: root }).toString().trim();
  const result = await loadImpactSnapshots(path.join(root, 'project'), commit);
  expect(result.base.files).toContainEqual({ file: '.crosscheck/config.yaml', state: 'present' });
}, 60000);
it('嵌套项目和 worktree 的 Git 文件可解析基线', async () => {
  const { root, git } = await repo(); await put(root, '子项目/.crosscheck/config.yaml', '{}'); git('add', '.'); git('commit', '-m', '初始');
  const other = await mkdtemp(path.join(os.tmpdir(), 'impact-worktree-')); roots.push(other); git('worktree', 'add', '--detach', other, 'HEAD');
  const result = await loadImpactSnapshots(path.join(other, '子项目'), 'HEAD');
  expect(result.base.files).toContainEqual({ file: '.crosscheck/config.yaml', state: 'present' });
});
it('基线模块目录为链接且无模块时仍诊断目录不安全', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); await put(root, 'target', '内容');
  await symlink(path.join(root, 'target'), path.join(root, '.crosscheck/requirements'), 'file'); git('add', '.'); git('commit', '-m', '链接');
  await rm(path.join(root, '.crosscheck/requirements'));
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.base.files).toContainEqual({ file: '.crosscheck/requirements', state: 'invalid' });
  expect(result.base.diagnostics).toContainEqual(expect.objectContaining({ code: 'restricted-input', file: '.crosscheck/requirements' }));
});
it('存在的提交引用指向缺失对象属于宿主故障', async () => {
  const { root, git } = await repo(); await put(root, 'a', 'a'); git('add', '.'); git('commit', '-m', '初始');
  await writeFile(path.join(root, '.git/refs/heads/broken'), `${'a'.repeat(40)}\n`);
  await expect(loadImpactSnapshots(root, 'broken')).rejects.toBeInstanceOf(ImpactHostError);
});
it('大量长模块路径分批查询而不超过 Windows 命令行限制', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}');
  const directory = path.join(root, '.crosscheck/requirements'); await mkdir(directory, { recursive: true });
  const names = Array.from({ length: 500 }, (_, i) => `M${String(i).padStart(4, '0')}_${'x'.repeat(90)}.yaml`);
  await Promise.all(names.map((name) => writeFile(path.join(directory, name), '[]')));
  git('add', '.'); git('commit', '-m', '大量模块');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.base.files.filter((f) => f.file.startsWith('.crosscheck/requirements/') && f.state === 'present')).toHaveLength(500);
}, 60000);
it('大量长精确路径保留树条目类型和全部索引状态', async () => {
  const { root, git } = await repo();
  const names = Array.from({ length: 500 }, (_, i) => `长目录/${String(i).padStart(4, '0')}-${'x'.repeat(90)}.md`);
  await Promise.all(names.map((name) => put(root, name, '内容')));
  git('add', '.'); git('commit', '-m', '长路径');
  const baseline = await openBaseline(root, 'HEAD');
  await baseline.populate(names);
  expect(baseline.tracked.size).toBe(500);
  for (const name of names) {
    expect(baseline.tracked.has(name)).toBe(true);
    expect(baseline.entries.get(name)).toEqual(expect.objectContaining({ mode: '100644', type: 'blob', size: 6 }));
  }
}, 60000);
it.each([3000, 9000])('单条 %i 字符长路径在批次目标之外仍能读取真实 Git 树与索引', async (length) => {
  const { root, git } = await repo();
  const name = `${'长'.repeat(length)}.md`;
  // 直接写 Git 对象与索引，不依赖 Windows 文件系统能否创建长路径。
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: '内容' }).toString().trim();
  const tree = execFileSync('git', ['mktree', '-z'], { cwd: root, input: `100644 blob ${blob}\t${name}\0` }).toString().trim();
  const commit = git('commit-tree', tree, '-m', '长路径树').toString().trim();
  execFileSync('git', ['update-index', '-z', '--index-info'], { cwd: root, input: `100644 ${blob}\t${name}\0` });
  const baseline = await openBaseline(root, commit);
  await baseline.populate([name]);
  expect(baseline.entries.get(name)).toEqual({ mode: '100644', type: 'blob', oid: blob, size: 6 });
  expect(baseline.tracked.has(name)).toBe(true);
}, 60000);
it.each([
  'x'.repeat(32700),
  `带空格 ${'\\'.repeat(16400)}".md`,
])('真正超过 Windows 命令行安全上限的路径归类为输入错误 %#', async (name) => {
  const { root, git } = await repo(); git('commit', '--allow-empty', '-m', '初始');
  const baseline = await openBaseline(root, 'HEAD');
  await expect(baseline.populate([name])).rejects.toBeInstanceOf(ImpactInputError);
});
it('单次 populate 的树批次与索引批次共享清单预算', async () => {
  const { root, git } = await repo();
  const names = Array.from({ length: 100 }, (_, i) => `${i.toString().padStart(3, '0')}-${'x'.repeat(96)}.md`);
  await Promise.all(names.map((name) => put(root, name, '内容')));
  git('add', '.'); git('commit', '-m', '多批次');
  const baseline = await openBaseline(root, 'HEAD');
  // 树清单与索引清单各自不足 20 KiB，但两阶段累计超过预算。
  await expect(baseline.populate(names, [], 20 * 1024)).rejects.toBeInstanceOf(ImpactInputError);
});
it('单次 populate 的多个目录读取共享清单预算', async () => {
  const { root, git } = await repo();
  await put(root, 'one/M01.yaml', '[]'); await put(root, 'two/M02.yaml', '[]');
  git('add', '.'); git('commit', '-m', '多目录');
  const baseline = await openBaseline(root, 'HEAD');
  // 祖先查询及每个目录单独都未超限，第二个目录会耗尽同一预算。
  await expect(baseline.populate([], ['one', 'two'], 256)).rejects.toBeInstanceOf(ImpactInputError);
});
it('清单预算在不同 populate 调用之间不累计', async () => {
  const { root, git } = await repo(); await put(root, 'a.md', '内容'); git('add', '.'); git('commit', '-m', '初始');
  const baseline = await openBaseline(root, 'HEAD');
  await baseline.populate(['a.md'], [], 100);
  await baseline.populate(['a.md'], [], 100);
  expect(baseline.tracked.has('a.md')).toBe(true);
});
it('模块目录内巨大的无关子树不占清单预算', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}');
  const lines: string[] = []; for (let i = 0; i < 18000; i++) lines.push(`100644 blob ${'a'.repeat(40)}\t${i.toString().padStart(5, '0')}-${'x'.repeat(900)}`);
  const blob = git('hash-object', '-w', '--stdin').toString().trim();
  const archive = execFileSync('git', ['mktree'], { cwd: root, input: lines.map((s) => s.replace('a'.repeat(40), blob)).join('\n') + '\n' }).toString().trim();
  const reqs = execFileSync('git', ['mktree'], { cwd: root, input: `040000 tree ${archive}\tarchive\n` }).toString().trim();
  const cfg = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: '{}' }).toString().trim();
  const cross = execFileSync('git', ['mktree'], { cwd: root, input: `100644 blob ${cfg}\tconfig.yaml\n040000 tree ${reqs}\trequirements\n` }).toString().trim();
  const tree = execFileSync('git', ['mktree'], { cwd: root, input: `040000 tree ${cross}\t.crosscheck\n` }).toString().trim();
  const commit = execFileSync('git', ['commit-tree', tree, '-m', '树'], { cwd: root }).toString().trim();
  const result = await loadImpactSnapshots(root, commit);
  expect(result.base.nodes).toContainEqual(expect.objectContaining({ key: 'config:project' }));
}, 60000);
it('解析出有效提交后对象丢失属于宿主故障', async () => {
  const { root, git } = await repo();
  const missing = 'a'.repeat(40);
  const tree = execFileSync('git', ['mktree', '--missing'], { cwd: root, input: `100644 blob ${missing}\tconfig.yaml\n` }).toString().trim();
  const full = execFileSync('git', ['mktree'], { cwd: root, input: `040000 tree ${tree}\t.crosscheck\n` }).toString().trim();
  const commit = execFileSync('git', ['commit-tree', full, '-m', '损坏'], { cwd: root }).toString().trim();
  await expect(loadImpactSnapshots(root, commit)).rejects.toBeInstanceOf(ImpactHostError);
});
it('仓库元数据损坏属于宿主故障', async () => {
  const { root, git } = await repo(); await put(root, 'a', 'a'); git('add', '.'); git('commit', '-m', '初始');
  await writeFile(path.join(root, '.git/HEAD'), 'invalid ref data');
  await expect(loadImpactSnapshots(root, 'HEAD')).rejects.toBeInstanceOf(ImpactHostError);
});
it('根项目大量无关 Git 条目不占分析清单预算', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}');
  const lines: string[] = []; for (let i = 0; i < 18000; i++) lines.push(`100644 blob ${'a'.repeat(40)}\t${i.toString().padStart(5, '0')}-${'x'.repeat(900)}`);
  const blob = git('hash-object', '-w', '--stdin').toString().trim();
  const tree = execFileSync('git', ['mktree'], { cwd: root, input: lines.map((s) => s.replace('a'.repeat(40), blob)).join('\n') + '\n' }).toString().trim();
  const cfg = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: '{}' }).toString().trim();
  const crossTree = execFileSync('git', ['mktree'], { cwd: root, input: `100644 blob ${cfg}\tconfig.yaml\n` }).toString().trim();
  const fullTree = execFileSync('git', ['mktree'], { cwd: root, input: `040000 tree ${crossTree}\t.crosscheck\n040000 tree ${tree}\tunrelated\n` }).toString().trim();
  const commit = execFileSync('git', ['commit-tree', fullTree, '-m', '树'], { cwd: root }).toString().trim();
  const result = await loadImpactSnapshots(root, commit);
  expect(result.base.nodes).toContainEqual(expect.objectContaining({ key: 'config:project' }));
}, 60000);
it('基线目录为符号链接时子文件不能视作安全缺失', async () => {
  const { root, git } = await repo(); await put(root, 'target', 'value'); git('add', '.'); git('commit', '-m', '初始');
  await symlink(path.join(root, 'target'), path.join(root, '.crosscheck'), 'file'); git('add', '.crosscheck'); git('commit', '-m', '链接');
  await rm(path.join(root, '.crosscheck')); await put(root, '.crosscheck/config.yaml', '{}');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.base.files).toContainEqual({ file: '.crosscheck/config.yaml', state: 'invalid' });
});
it('读取期间原先不存在的模块目录创建时报告并发变化', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); git('add', '.'); git('commit', '-m', '初始');
  const result = await loadImpactSnapshots(root, 'HEAD', undefined, { beforeRecheck: async () => { await put(root, '.crosscheck/cases/M01.yaml', '[]'); } });
  expect(result.current.diagnostics).toContainEqual(expect.objectContaining({ code: 'concurrent-change', file: '.crosscheck/cases' }));
});
it('基线模块清单超过两千也在索引查询前截断，不输出未检查文件 missing', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', '{}'); git('add', '.'); git('commit', '-m', '初始');
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: '[]' }).toString().trim();
  const reqs = execFileSync('git', ['mktree'], { cwd: root, input: Array.from({ length: 2300 }, (_, i) => `100644 blob ${blob}\tM${String(i).padStart(4, '0')}.yaml\n`).join('') }).toString().trim();
  const cfg = git('rev-parse', 'HEAD:.crosscheck/config.yaml').toString().trim();
  const cross = execFileSync('git', ['mktree'], { cwd: root, input: `100644 blob ${cfg}\tconfig.yaml\n040000 tree ${reqs}\trequirements\n` }).toString().trim();
  const tree = execFileSync('git', ['mktree'], { cwd: root, input: `040000 tree ${cross}\t.crosscheck\n` }).toString().trim();
  const commit = git('commit-tree', tree, '-m', '大量模块树').toString().trim();
  const baseline = await openBaseline(root, commit);
  await baseline.populate(['.crosscheck/config.yaml'], ['.crosscheck/requirements']);
  expect([...baseline.entries.keys()].filter((f) => f.endsWith('.yaml')).length).toBeLessThanOrEqual(2000);
  const result = await loadImpactSnapshots(root, commit);
  expect(result.base.diagnostics.some((d) => d.code === 'file-limit')).toBe(true);
  expect(result.current.files.some((f) => f.file.endsWith('M2299.yaml'))).toBe(false);
  expect(result.base.files).toContainEqual({ file: '.crosscheck/requirements', state: 'invalid' });
}, 30000);
it('超过两千个缺失文档在资源访问前截断候选，报告有界且不伪造删除', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [z-existing.md]');
  await put(root, 'z-existing.md', '保留原文'); git('add', '.'); git('commit', '-m', '初始');
  await put(root, '.crosscheck/config.yaml', JSON.stringify({ requirementsDocs: [...Array.from({ length: 6000 }, (_, i) => `missing-${i}.md`), 'z-existing.md'] }));
  const result = await loadImpactSnapshots(root, 'HEAD');
  for (const snapshot of [result.base, result.current]) {
    expect(snapshot.diagnostics).toContainEqual({ code: 'file-limit', message: '两侧相关文件候选并集超过 2000 个上限，未检查范围无法确认' });
    expect(new Set(snapshot.files.map((f) => f.file)).size).toBeLessThanOrEqual(2000);
    expect(snapshot.diagnostics.length).toBeLessThan(2010);
    expect(snapshot.files.some((f) => f.file === 'missing-5999.md')).toBe(false);
  }
  expect(compareSnapshots(result.base, result.current).some((c) => c.key === 'document:z-existing.md' && c.kind === 'deleted')).toBe(false);
}, 30000);
it('登记但不存在的需求文档产生缺口', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [missing.md]'); git('add', '.'); git('commit', '-m', '初始');
  const { current } = await loadImpactSnapshots(root, 'HEAD');
  expect(current.diagnostics).toContainEqual(expect.objectContaining({ code: 'missing-document', file: 'missing.md' }));
});
it('同一文件既是配置也是需求文档时仍计入文档预算', async () => {
  const { root, git } = await repo();
  await put(root, '.crosscheck/config.yaml', `requirementsDocs: [.crosscheck/config.yaml, a.md, b.md]\n# ${'x'.repeat(600000)}`);
  await put(root, 'a.md', 'a'.repeat(800000)); await put(root, 'b.md', 'b'.repeat(800000)); git('add', '.'); git('commit', '-m', '初始');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.files).toContainEqual({ file: 'b.md', state: 'invalid' });
});
it('登记在 crosscheck 下的文档也受需求文档总预算限制', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [.crosscheck/a.md, .crosscheck/b.md, .crosscheck/c.md]');
  for (const name of ['a', 'b', 'c']) await put(root, `.crosscheck/${name}.md`, 'a'.repeat(800000));
  git('add', '.'); git('commit', '-m', '初始');
  const { current } = await loadImpactSnapshots(root, 'HEAD');
  expect(current.files).toContainEqual({ file: '.crosscheck/c.md', state: 'invalid' });
});
it('暂存的新增文档不是缺失历史', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); git('add', '.'); git('commit', '-m', '初始');
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [new.md]'); await put(root, 'new.md', '新增'); git('add', 'new.md');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(compareSnapshots(result.base, result.current)).toContainEqual(expect.objectContaining({ key: 'document:new.md', kind: 'added' }));
  expect(result.base.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'history-incomplete', file: 'new.md' }));
});
it('未跟踪文档产生历史缺口但保留新增', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); git('add', '.'); git('commit', '-m', '初始');
  await put(root, '.crosscheck/config.yaml', 'requirementsDocs: [new.md]'); await put(root, 'new.md', '新增');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.base.diagnostics).toContainEqual(expect.objectContaining({ code: 'history-incomplete', file: 'new.md' }));
  expect(compareSnapshots(result.base, result.current)).toContainEqual(expect.objectContaining({ key: 'document:new.md', kind: 'added' }));
});
it('目录被普通文件阻塞时识别为受限输入而非宿主故障', async () => {
  const { root, git } = await repo(); await put(root, '.crosscheck/config.yaml', '{}'); git('add', '.'); git('commit', '-m', '初始');
  await put(root, '.crosscheck/requirements', '不是目录');
  const result = await loadImpactSnapshots(root, 'HEAD');
  expect(result.current.diagnostics).toContainEqual(expect.objectContaining({ code: 'restricted-input', file: '.crosscheck/requirements' }));
});
it('不存在的项目路径是输入错误', async () => {
  const { root } = await repo();
  await expect(loadImpactSnapshots(path.join(root, 'missing'), 'HEAD')).rejects.toBeInstanceOf(ImpactInputError);
});
it('项目路径为普通文件时是受限输入', async () => {
  const { root } = await repo(); await put(root, 'file', 'text');
  await expect(loadImpactSnapshots(path.join(root, 'file'), 'HEAD')).rejects.toBeInstanceOf(ImpactInputError);
});
it('宿主进程错误不被归类为输入错误', async () => {
  const { root } = await repo();
  const old = process.env.PATH; process.env.PATH = '';
  try { await expect(loadImpactSnapshots(root, 'HEAD')).rejects.toBeInstanceOf(ImpactHostError); }
  finally { process.env.PATH = old; }
});
it('拒绝选项形式的基线', async () => {
  const { root, git } = await repo(); await put(root, 'a', 'a'); git('add', '.'); git('commit', '-m', '初始');
  await expect(loadImpactSnapshots(root, '--help')).rejects.toBeInstanceOf(ImpactInputError);
});
