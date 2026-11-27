import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AUTO_REVIEWER, Approvals, ArtifactError, ArtifactStore, readProfileFile, readProfileFiles } from '@crosscheck/core';
import * as discovery from '@crosscheck/discovery';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import type { CommandDependencies } from '../src/context';
import { cliMain } from '../src/main';
import { createSlashDispatcher } from '../src/session';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const source = { file: 'server/users.ts', line: 1, excerpt: "app.get('/users', primary);" };
const fake = { ...source, line: 2, excerpt: "app.get('/users-secondary', secondary);" };
const operation = (ref = source) => ({ environment: 'local', method: 'GET', path: ref.line === 1 ? '/users' : '/users-secondary', description: '用户列表', sources: [ref] });
const page = { environment: 'local', path: '/users', description: '用户页', sources: [source] };
const apiName = 'api-catalog.yaml';
const apiPath = `system/${apiName}`;
const manual = ['environments.yaml', 'auth.yaml', 'data-model.yaml', 'fixtures.yaml', 'guardrails.yaml'];
const catalog = (operations: Record<string, unknown>) => ({ version: 1, operations });
const finish = (input: Record<string, unknown>): ScriptStep => ({ toolCalls: [{ name: 'finish', input }] });
function script(api = catalog({ users: operation() }), pages: { version: number; pages: Record<string, unknown> } = { version: 1, pages: { users: page } }, findings: unknown[] = [source, fake].map((ref) => ({ kind: 'api', method: 'GET', path: operation(ref).path, source: ref }))): ScriptStep[] {
  return [
    finish({ markdown: '# 项目笔记\n\n扫描结果' }),
    finish({ findings }),
    finish({ 'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:3000', healthcheck: 'http://localhost:3000/health', reset: null } } } }),
    finish({ 'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } } }),
    finish({ [apiName]: api, 'pages.yaml': pages }),
    finish({ 'data-model.yaml': { version: 1, queries: {} }, 'fixtures.yaml': { version: 1, fixtures: {} } }),
    finish({ 'guardrails.yaml': { allowedHosts: ['localhost:3000'] } }),
  ];
}
async function project(steps = script()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cli-init-all-')); roots.push(root);
  const artifacts = new ArtifactStore(root);
  const home = path.join(root, 'user');
  await mkdir(path.join(home, '.crosscheck'), { recursive: true });
  await writeFile(path.join(home, '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' }, providers: { mock: { type: 'openai', baseURL: 'https://example.invalid/v1', apiKey: 'fixture-key' } } }));
  await artifacts.writeYaml('config.yaml', {});
  await mkdir(path.join(root, 'server'));
  await writeFile(path.join(root, source.file), `${source.excerpt}\n${fake.excerpt}\n`);
  // 两条来源先通过真实探索及画像生成；生成结果返回后移走第二条来源，供 init 独立重验。
  const synthesize = discovery.synthesizeProfile;
  vi.spyOn(discovery, 'synthesizeProfile').mockImplementation(async (options) => {
    const result = await synthesize(options);
    await writeFile(path.join(root, source.file), `${source.excerpt}\n`);
    return result;
  });
  const model = scriptedModel(steps);
  const deps: CommandDependencies = {
    userConfigHome: home, modelOptions: { env: {}, factories: { openai: () => model } },
    resilience: { retries: 0, baseDelayMs: 0 }, review: { isTTY: false },
  };
  const lines: string[] = [];
  const init = (extra: Partial<CommandDependencies> = {}, signal?: AbortSignal, flags: string[] = []) => cliMain(['init', '--project', root, ...flags], {
    dependencies: { ...deps, ...extra }, signal, log: (line) => lines.push(line),
  });
  const reqs = (extractor: ReturnType<typeof scriptedModel>) => cliMain(['reqs', '--project', root, '--module', 'M'], {
    dependencies: { ...deps, modelOptions: { ...deps.modelOptions, factories: { openai: () => extractor } } }, log: (line) => lines.push(line),
  });
  return { root, artifacts, deps, lines, init, reqs, model };
}
async function payload(artifacts: ArtifactStore, name: 'api-catalog.yaml' | 'pages.yaml') {
  const file = await readProfileFile(artifacts, name);
  if (!file.present || !file.ok) throw new Error(`测试画像无效：${name}`);
  return file.value;
}

it.each(['登记成功', '忽略文件', '目录混有忽略文件', '扫描后新增', '目录扫描后新增', '深度截断', '读取超限', '遍历诊断'] as const)('reqs 仅信任生成笔记时实际登记且扫描完整的需求文档（%s）', async (kind) => {
  const doc = { file: 'docs/req.md', line: 1, excerpt: '专属需求正文' };
  const notes = `# 笔记\n\n## 需求文档\n\n- \`${kind === '忽略文件' || kind === '扫描后新增' ? 'docs/hidden.md' : 'docs/'}\`\n`;
  const { root, init, reqs, model, lines, artifacts } = await project([finish({ markdown: notes }), ...script().slice(1)]);
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, doc.file), doc.excerpt);
  if (kind === '忽略文件' || kind === '目录混有忽略文件') {
    await writeFile(path.join(root, '.gitignore'), 'docs/hidden.md\n');
    await writeFile(path.join(root, 'docs/hidden.md'), '不可发送');
  }
  if (kind === '深度截断') {
    const dir = path.join(root, 'docs', ...Array(9).fill('sub'));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'deep.md'), '不可静默省略');
  }
  if (kind === '读取超限') await writeFile(path.join(root, 'docs/large.md'), Buffer.alloc(1024 * 1024 + 1, 'x'));
  if (kind === '遍历诊断') await mkdir(path.join(root, '.gitignore'));
  expect(await init()).toBe(2);
  expect((await Approvals.load(artifacts)).record('notes', 'project')?.by).toBe('auto');
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toContain(doc.excerpt);
  if (kind === '扫描后新增' || kind === '目录扫描后新增') await writeFile(path.join(root, 'docs/hidden.md'), '不可发送');
  const extractor = scriptedModel([{ toolCalls: [{ name: 'finish', input: [{ id: 'M-AC-1', text: doc.excerpt, source: doc }] }] }]);
  expect(await reqs(extractor)).toBe(kind === '登记成功' ? 0 : 2);
  if (kind === '登记成功') expect(JSON.stringify(extractor.doGenerateCalls[0]!.prompt)).toContain(doc.excerpt);
  else {
    expect(extractor.doGenerateCalls).toHaveLength(0);
    expect(await artifacts.list('requirements')).toEqual([]);
    expect(lines.join('\n')).toMatch(/requirementsDocs.*review notes/);
  }
});

it('非 TTY 自动确认笔记和两份来源通过的画像，仅列出其余五份', async () => {
  const { artifacts, lines, init } = await project();
  const code = await init();
  const approvals = await Approvals.load(artifacts);
  expect(approvals.record('notes', 'project')?.by).toBe(AUTO_REVIEWER);
  expect(approvals.state('notes', 'project', (await artifacts.readBytes('notes.md'))?.toString())).toBe('approved');
  for (const name of [apiName, 'pages.yaml'] as const) {
    expect(approvals.record('profile', name)?.by).toBe(AUTO_REVIEWER);
    expect(approvals.state('profile', name, await payload(artifacts, name))).toBe('approved');
  }
  for (const name of manual) expect(approvals.record('profile', name)).toBeUndefined();
  expect(code).toBe(2);
  expect(lines).toContain(`以下画像需要人工确认：${manual.join('、')}`);
  expect(lines.join('\n')).toContain('review profile');
  await expect(artifacts.listModules('requirements')).resolves.toEqual([]);
  await expect(artifacts.listModules('cases')).resolves.toEqual([]);
});

it('init 将显式 --openapi 传给画像生成，核验并确认来自非默认路径的接口', async () => {
  const ref = { file: 'custom-spec.yaml', line: 4, excerpt: 'get: { summary: 用户列表 }' };
  const { root, artifacts, init } = await project(script(catalog({ users: { ...operation(), sources: [ref] } }), { version: 1, pages: {} }, []));
  await writeFile(path.join(root, ref.file), `openapi: 3.0.0\npaths:\n  /users:\n    ${ref.excerpt}\n`);
  expect(await init({}, undefined, ['--openapi', ref.file])).toBe(2);
  const saved = await payload(artifacts, apiName);
  expect(saved).toEqual(catalog({ users: { ...operation(), sources: [ref], knowledge: [] } }));
  expect((await Approvals.load(artifacts)).state('profile', apiName, saved)).toBe('approved');
});

it('单行带空格的 JSON OpenAPI 摘录能通过自动确认', async () => {
  const ref = { file: 'custom-spec.json', line: 1, excerpt: '{ "openapi": "3.0.0", "paths": { "/users": { "get": { "summary": "用户列表" } } } }' };
  const modelRef = { ...ref, excerpt: '{"openapi":"3.0.0","paths":{"/users":{"get":{"summary":"用户列表"}}}}' };
  const { root, artifacts, init } = await project(script(catalog({ users: { ...operation(), sources: [modelRef] } }), { version: 1, pages: {} }, []));
  await writeFile(path.join(root, ref.file), ref.excerpt);
  expect(await init({}, undefined, ['--openapi', ref.file])).toBe(2);
  expect((await Approvals.load(artifacts)).state('profile', apiName, await payload(artifacts, apiName))).toBe('approved');
});

it.each([false, true])('OpenAPI 单行 JSON 的普通 URL 规范化只接受真实证据（来源后来变化：%s）', async (changed) => {
  const file = 'custom-spec.json';
  const raw = '{ "openapi": "3.0.0", "servers": [{ "url": "https://example.invalid" }], "paths": { "/special": { "get": {} } } }';
  const ref = { file, line: 1, excerpt: '{"openapi":"3.0.0","servers":[{"url":"https://example.invalid/"}],"paths":{"/special":{"get":{}}}}' };
  const { root, artifacts, init } = await project(script(catalog({ users: operation(), custom: { ...operation(), path: '/special', sources: [ref] } })));
  await writeFile(path.join(root, file), raw);
  const verify = discovery.verifyEntrySources;
  if (changed) vi.spyOn(discovery, 'verifyEntrySources').mockImplementation(async (options) => {
    if (Object.hasOwn(options.entries, 'custom')) await writeFile(path.join(root, file), raw.replace('example.invalid', 'different.invalid'));
    return verify(options);
  });
  expect(await init({}, undefined, ['--openapi', file])).toBe(2);
  const saved = await payload(artifacts, apiName);
  expect(Object.keys((saved as { operations: object }).operations)).toEqual(changed ? ['users'] : ['users', 'custom']);
  if (!changed) expect(saved).toMatchObject({ operations: { custom: { sources: [ref] } } });
  expect((await Approvals.load(artifacts)).state('profile', apiName, saved)).toBe('approved');
});

it('显式 OpenAPI 路径中间含点段时不会误剔除真实来源', async () => {
  const ref = { file: 'docs/./custom.yaml', line: 4, excerpt: 'get: { summary: 特殊接口 }' };
  const { root, artifacts, init } = await project(script(catalog({ users: operation(), custom: { ...operation(), path: '/special', sources: [ref] } })));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, ref.file), `openapi: 3.0.0\npaths:\n  /special:\n    ${ref.excerpt}\n`);
  expect(await init({}, undefined, ['--openapi', ref.file])).toBe(2);
  expect(await payload(artifacts, apiName)).toMatchObject({ operations: { users: operation(), custom: { sources: [ref] } } });
  expect((await Approvals.load(artifacts)).state('profile', apiName, await payload(artifacts, apiName))).toBe('approved');
});

it('显式 OpenAPI 被项目忽略时，保留其中条目及其他已核验条目，不自动确认', async () => {
  const ref = { file: 'custom-spec.yaml', line: 4, excerpt: 'get: { summary: 特殊接口 }' };
  const { root, artifacts, init, lines } = await project(script(catalog({ users: operation(), custom: { ...operation(), path: '/special', sources: [ref] } })));
  await writeFile(path.join(root, '.gitignore'), `${ref.file}\n`);
  await writeFile(path.join(root, ref.file), `openapi: 3.0.0\npaths:\n  /special:\n    ${ref.excerpt}\n`);
  expect(await init({}, undefined, ['--openapi', ref.file])).toBe(2);
  expect(await payload(artifacts, apiName)).toMatchObject({ operations: { users: operation(), custom: { sources: [ref] } } });
  expect((await Approvals.load(artifacts)).record('profile', apiName)).toBeUndefined();
  expect(lines.join('\n')).toMatch(/显式.*未登记.*人工/);
});

it('登记来源无法读取时保留整份画像原稿且不确认', async () => {
  const ref = { ...fake, file: 'server/secondary.ts', line: 1 };
  const { root, artifacts, init, lines } = await project(script(catalog({ users: operation(), secondary: { ...operation(fake), sources: [ref] } }), undefined, [{ kind: 'api', method: 'GET', path: '/users', source }, { kind: 'api', method: 'GET', path: '/users-secondary', source: ref }]));
  await writeFile(path.join(root, ref.file), ref.excerpt);
  const verify = discovery.verifyEntrySources;
  let before: Buffer | undefined;
  vi.spyOn(discovery, 'verifyEntrySources').mockImplementation(async (options) => {
    if (Object.hasOwn(options.entries, 'secondary')) {
      before = await artifacts.readBytes(apiPath);
      // 登记后由普通文件变为不可作为文本读取的目录；无需真实磁盘故障或权限修改。
      await rm(path.join(root, ref.file));
      await mkdir(path.join(root, ref.file));
    }
    return verify(options);
  });
  expect(await init()).toBe(2);
  expect(before).toBeDefined();
  expect(await artifacts.readBytes(apiPath)).toEqual(before);
  expect((await Approvals.load(artifacts)).record('profile', apiName)).toBeUndefined();
  expect(lines.join('\n')).toMatch(/无法.*重试.*人工/);
});

it('仅剔除来源不通过的条目，并确认 schema 解析后的落盘载荷；编辑后失效', async () => {
  const { artifacts, lines, init } = await project(script(catalog({ users: operation(), fake: operation(fake) })));
  await init();
  const saved = await payload(artifacts, apiName);
  expect(saved).toEqual(catalog({ users: { ...operation(), knowledge: [] } }));
  expect((await Approvals.load(artifacts)).state('profile', apiName, saved)).toBe('approved');
  expect(lines.join('\n')).toContain('剔除 fake');
  await artifacts.writeYaml(apiPath, catalog({ users: { ...operation(), description: '人工编辑' } }));
  expect((await Approvals.load(artifacts)).state('profile', apiName, await payload(artifacts, apiName))).toBe('stale');
});

it('全部不通过或条目为空时保留草稿，交给人工审核', async () => {
  const { artifacts, lines, init } = await project(script(catalog({ fake: operation(fake) }), { version: 1, pages: {} }));
  expect(await init()).toBe(2);
  expect(await payload(artifacts, apiName)).toEqual(catalog({ fake: { ...operation(fake), knowledge: [] } }));
  const approvals = await Approvals.load(artifacts);
  expect(approvals.record('profile', apiName)).toBeUndefined();
  expect(approvals.record('profile', 'pages.yaml')).toBeUndefined();
  expect(lines).toContain(`以下画像需要人工确认：environments.yaml、auth.yaml、${apiName}、pages.yaml、data-model.yaml、fixtures.yaml、guardrails.yaml`);
});

it.each([0, 2])('TTY 仅打开待审画像并保留审核退出码 %s', async (exitCode) => {
  const { init, lines } = await project();
  const received: unknown[] = [];
  expect(await init({ review: { isTTY: true, userInfo: () => ({ username: '测试人' }), runReview: async ({ view, only }) => {
    received.push({ view, only });
    return exitCode;
  } } })).toBe(exitCode);
  expect(received).toEqual([{ view: 'profile', only: manual }]);
  expect(lines.join('\n')).toContain('仍有 5 份画像未确认');
});

it('会话 /init 交接显式项目、仅待审项和实时日志，不打开独立审核', async () => {
  const { root, deps } = await project();
  const progress: string[] = [];
  const runReview = vi.fn(async () => 0);
  const dispatch = createSlashDispatcher({ ...deps, review: { isTTY: true, runReview } });
  const result = await dispatch(['init', '--project', root], new AbortController().signal, (line) => progress.push(line));
  expect(result).toMatchObject({ kind: 'review', args: { project: root, view: 'profile', only: manual }, lines: expect.arrayContaining([`以下画像需要人工确认：${manual.join('、')}`]) });
  expect(progress).toContain(`以下画像需要人工确认：${manual.join('、')}`);
  expect(runReview).not.toHaveBeenCalled();
});

it.each([false, true])('全部确认后重跑保留画像批准；只有 --refresh 重生成笔记（%s）', async (refresh) => {
  const { artifacts, deps, init } = await project();
  await init();
  const approvals = await Approvals.load(artifacts);
  for (const file of await readProfileFiles(artifacts)) {
    if (file.present && file.ok && !approvals.record('profile', file.name)) approvals.approve('profile', file.name, file.value, '人工');
  }
  await approvals.save(artifacts);
  const before = await artifacts.readBytes('approvals.json');
  const model = scriptedModel(refresh ? [finish({ markdown: '# 刷新后的笔记' })] : []);
  expect(await init({ modelOptions: { ...deps.modelOptions, factories: { openai: () => model } } }, undefined, refresh ? ['--refresh'] : [])).toBe(0);
  expect(model.doGenerateCalls).toHaveLength(refresh ? 1 : 0);
  if (refresh) {
    const latest = await Approvals.load(artifacts);
    expect((await artifacts.readBytes('notes.md'))?.toString()).toBe('# 刷新后的笔记');
    expect(latest.state('notes', 'project', '# 刷新后的笔记')).toBe('approved');
    for (const file of await readProfileFiles(artifacts)) expect(latest.record('profile', file.name)).toEqual(approvals.record('profile', file.name));
  } else {
    expect(await artifacts.readBytes('approvals.json')).toEqual(before);
  }
});

it.each(['编辑笔记', '撤销确认'] as const)('TTY 确认全部画像后复查笔记，期间%s时退出 2', async (event) => {
  const { artifacts, init, lines } = await project();
  expect(await init({ review: { isTTY: true, userInfo: () => ({ username: '测试人' }), runReview: async ({ only }) => {
    const approvals = await Approvals.load(artifacts);
    for (const file of await readProfileFiles(artifacts)) {
      if (file.present && file.ok && only?.includes(file.name)) approvals.approve('profile', file.name, file.value, '人工');
    }
    if (event === '编辑笔记') await artifacts.writeBytes('notes.md', Buffer.from('# 人工编辑'));
    else approvals.revoke('notes', 'project');
    await approvals.save(artifacts);
    return 0;
  } } })).toBe(2);
  expect(lines.join('\n')).toMatch(/笔记.*尚未确认或确认已失效/);
  expect(lines).not.toContain('笔记与七份画像均已确认');
});

it('所有画像分别确认也不能掩盖 fixture 引用被剔除，且不改人工记录', async () => {
  const { artifacts, deps, init, lines } = await project(script(catalog({ users: operation(), removed: operation(fake) })));
  expect(await init()).toBe(2);
  await artifacts.writeYaml('system/fixtures.yaml', { version: 1, fixtures: { prepare: { kind: 'http', operation: 'removed' } } });
  const approvals = await Approvals.load(artifacts);
  for (const file of await readProfileFiles(artifacts)) {
    if (file.present && file.ok && !approvals.record('profile', file.name)) approvals.approve('profile', file.name, file.value, '人工');
  }
  await approvals.save(artifacts);
  const before = await artifacts.readBytes('approvals.json');
  lines.length = 0;
  const model = scriptedModel([]);
  expect(await init({ modelOptions: { ...deps.modelOptions, factories: { openai: () => model } } })).toBe(2);
  expect(lines.join('\n')).toContain('fixture prepare 的 API 操作不存在：removed');
  expect(lines).not.toContain('笔记与七份画像均已确认');
  expect(await artifacts.readBytes('approvals.json')).toEqual(before);
  expect(model.doGenerateCalls).toHaveLength(0);
});

it.each([false, true])('全确认且没有模型配置时仍完成交叉校验（冲突：%s）', async (conflict) => {
  const { root, artifacts, init, lines } = await project();
  expect(await init()).toBe(2);
  if (conflict) await artifacts.writeYaml('system/fixtures.yaml', { version: 1, fixtures: { bad: { kind: 'http', operation: 'missing' } } });
  const approvals = await Approvals.load(artifacts);
  for (const file of await readProfileFiles(artifacts)) {
    if (!file.present || !file.ok) throw new Error(`测试画像无效：${file.name}`);
    approvals.approve('profile', file.name, file.value, '人工');
  }
  await approvals.save(artifacts);
  await rm(path.join(root, 'user', '.crosscheck', 'config.yaml'));
  lines.length = 0;
  expect(await init()).toBe(conflict ? 2 : 0);
  expect(lines.join('\n')).toContain(conflict ? 'fixture bad 的 API 操作不存在：missing' : '笔记与七份画像均已确认');
});

it('刷新返回孤立 UTF-16 码元时保留原笔记字节和确认', async () => {
  const { artifacts, init, lines } = await project([finish({ markdown: '# 不可编码\ud800' })]);
  const text = '# 原笔记\n';
  const bytes = Buffer.from(text);
  await artifacts.writeBytes('notes.md', bytes);
  const approvals = Approvals.empty();
  approvals.approve('notes', 'project', text, '人工');
  await approvals.save(artifacts);
  const before = await artifacts.readBytes('approvals.json');
  expect(await init({}, undefined, ['--refresh'])).toBe(2);
  expect(await artifacts.readBytes('notes.md')).toEqual(bytes);
  expect(await artifacts.readBytes('approvals.json')).toEqual(before);
  expect(lines.join('\n')).toMatch(/UTF-8.*未写入/);
  expect(lines.join('\n')).not.toContain('笔记已写入');
});

it('最终画像交叉校验的真实宿主读取故障仍退出 3', async () => {
  const { artifacts, init, lines } = await project();
  const read = ArtifactStore.prototype.readYaml;
  vi.spyOn(ArtifactStore.prototype, 'readYaml').mockImplementation(function (this: ArtifactStore, rel, schema) {
    if (rel === apiPath) throw new ArtifactError('工件读取失败', { cause: new Error('测试磁盘故障') });
    return read.call(this, rel, schema);
  });
  expect(await init({ review: { isTTY: true, userInfo: () => ({ username: '测试人' }), runReview: async ({ only }) => {
    const approvals = await Approvals.load(artifacts);
    for (const file of await readProfileFiles(artifacts)) {
      if (file.present && file.ok && only?.includes(file.name)) approvals.approve('profile', file.name, file.value, '人工');
    }
    await approvals.save(artifacts);
    return 0;
  } } })).toBe(3);
  expect(lines.join('\n')).toContain('宿主错误：工件读取失败');
  expect((await Approvals.load(artifacts)).record('profile', 'fixtures.yaml')?.by).toBe('人工');
});

it('结束复查重读笔记期间撤销批准，不沿用旧审核表报告成功', async () => {
  const { artifacts, init, lines } = await project();
  let notesReads = 0;
  const read = ArtifactStore.prototype.readBytes;
  vi.spyOn(ArtifactStore.prototype, 'readBytes').mockImplementation(async function (this: ArtifactStore, rel) {
    const bytes = await read.call(this, rel);
    if (rel === 'notes.md' && notesReads > 0 && --notesReads === 0) {
      const approvals = await Approvals.load(artifacts);
      approvals.revoke('notes', 'project');
      await approvals.save(artifacts);
    }
    return bytes;
  });
  expect(await init({ review: { isTTY: true, userInfo: () => ({ username: '测试人' }), runReview: async ({ only }) => {
    const approvals = await Approvals.load(artifacts);
    for (const file of await readProfileFiles(artifacts)) {
      if (file.present && file.ok && only?.includes(file.name)) approvals.approve('profile', file.name, file.value, '人工');
    }
    await approvals.save(artifacts);
    // 审核返回后，第一次读建立笔记基线，第二次读在结束复查中触发撤销。
    notesReads = 2;
    return 0;
  } } })).toBe(2);
  expect((await Approvals.load(artifacts)).record('notes', 'project')).toBeUndefined();
  expect(lines.join('\n')).toContain('项目笔记尚未确认或确认已失效');
  expect(lines).not.toContain('笔记与七份画像均已确认');
});

it('写入笔记前最终加载审核表期间发生编辑，不覆盖人工内容', async () => {
  const { artifacts, init, lines } = await project();
  let loads = 0;
  const synthesize = discovery.synthesizeNotes;
  vi.spyOn(discovery, 'synthesizeNotes').mockImplementation(async (options) => {
    const result = await synthesize(options);
    loads = 2;
    return result;
  });
  const load = Approvals.load;
  vi.spyOn(Approvals, 'load').mockImplementation(async (store) => {
    const approvals = await load(store);
    if (loads > 0 && --loads === 0) await artifacts.writeBytes('notes.md', Buffer.from('# 人工编辑'));
    return approvals;
  });
  expect(await init()).toBe(2);
  expect((await artifacts.readBytes('notes.md'))?.toString()).toBe('# 人工编辑');
  expect((await Approvals.load(artifacts)).record('notes', 'project')).toBeUndefined();
  expect(lines.join('\n')).toContain('未覆盖');
  expect(await artifacts.list('system')).toEqual([]);
});

// 保留真实来源核验，只在验证结果返回给 init 前插入竞争操作。
function duringCatalogVerification(effect: () => Promise<void> | void) {
  const verify = discovery.verifyEntrySources;
  return vi.spyOn(discovery, 'verifyEntrySources').mockImplementation(async (options) => {
    const result = await verify(options);
    if (Object.hasOwn(options.entries, 'catalog_marker')) await effect();
    return result;
  });
}

it.each([false, true])('核验期间文件被替换时不覆盖、不确认（有剔除：%s）', async (drop) => {
  const { artifacts, lines, init } = await project(script(catalog({ catalog_marker: operation(), ...(drop ? { fake: operation(fake) } : {}) })));
  const replacement = catalog({ unverified: operation(fake) });
  duringCatalogVerification(() => artifacts.writeYaml(apiPath, replacement));
  expect(await init()).toBe(2);
  expect(await payload(artifacts, apiName)).toEqual(catalog({ unverified: { ...operation(fake), knowledge: [] } }));
  expect((await Approvals.load(artifacts)).record('profile', apiName)).toBeUndefined();
  expect(lines.join('\n')).toMatch(/api-catalog\.yaml.*跳过自动确认/);
});

it.each([[false, 1], [true, 1], [false, 2], [true, 2]] as const)('检查读取审核表期间文件被替换时不覆盖、不确认（有剔除：%s，加载次数：%s）', async (drop, loadNumber) => {
  const { artifacts, init } = await project(script(catalog({ catalog_marker: operation(), ...(drop ? { fake: operation(fake) } : {}) })));
  const replacement = catalog({ unverified: operation(fake) });
  let loads = 0;
  duringCatalogVerification(() => { loads = loadNumber; });
  const load = Approvals.load;
  vi.spyOn(Approvals, 'load').mockImplementation(async (store) => {
    const result = await load(store);
    if (loads > 0 && --loads === 0) await artifacts.writeYaml(apiPath, replacement);
    return result;
  });
  expect(await init()).toBe(2);
  expect(await payload(artifacts, apiName)).toEqual(catalog({ unverified: { ...operation(fake), knowledge: [] } }));
  expect((await Approvals.load(artifacts)).record('profile', apiName)).toBeUndefined();
});

it.each([false, true])('最终重读目标期间的人工批准不被旧审核表覆盖（有剔除：%s）', async (drop) => {
  const { artifacts, init } = await project(script(catalog({ catalog_marker: operation(), ...(drop ? { fake: operation(fake) } : {}) })));
  let reads = 0;
  duringCatalogVerification(() => { reads = 2; });
  const read = ArtifactStore.prototype.readBytes;
  vi.spyOn(ArtifactStore.prototype, 'readBytes').mockImplementation(async function (this: ArtifactStore, rel) {
    const bytes = await read.call(this, rel);
    if (rel === apiPath && reads > 0 && --reads === 0) {
      const approvals = await Approvals.load(artifacts);
      approvals.approve('profile', apiName, await payload(artifacts, apiName), '重读期间人工');
      await approvals.save(artifacts);
    }
    return bytes;
  });
  expect(await init()).toBe(2);
  const approvals = await Approvals.load(artifacts);
  expect(approvals.record('profile', apiName)?.by).toBe('重读期间人工');
  expect(approvals.state('profile', apiName, await payload(artifacts, apiName))).toBe('approved');
  expect(Object.keys((await payload(artifacts, apiName) as { operations: object }).operations)).toEqual(drop ? ['catalog_marker', 'fake'] : ['catalog_marker']);
});

it.each([false, true])('核验期间人工审核记录变化时保留人工批准和原文件（有剔除：%s）', async (drop) => {
  const { artifacts, lines, init } = await project(script(catalog({ catalog_marker: operation(), ...(drop ? { fake: operation(fake) } : {}) })));
  let before: Buffer | undefined;
  duringCatalogVerification(async () => {
    before = await artifacts.readBytes(apiPath);
    const approvals = await Approvals.load(artifacts);
    approvals.approve('profile', apiName, await payload(artifacts, apiName), '并发人工');
    await approvals.save(artifacts);
  });
  expect(await init()).toBe(2);
  expect(before).toBeDefined();
  expect(await artifacts.readBytes(apiPath)).toEqual(before);
  const approvals = await Approvals.load(artifacts);
  expect(approvals.record('profile', apiName)?.by).toBe('并发人工');
  expect(approvals.state('profile', apiName, await payload(artifacts, apiName))).toBe('approved');
  expect(lines.join('\n')).toMatch(/api-catalog\.yaml.*跳过自动确认/);
});

it.each(['替换', '人工确认', '取消', '写盘失败'] as const)('剔除写盘竞争：%s 不产生自动批准', async (event) => {
  const { artifacts, init } = await project(script(catalog({ catalog_marker: operation(), fake: operation(fake) })));
  const controller = new AbortController();
  let verified = false;
  duringCatalogVerification(() => { verified = true; });
  const write = ArtifactStore.prototype.writeBytes;
  vi.spyOn(ArtifactStore.prototype, 'writeBytes').mockImplementation(async function (this: ArtifactStore, rel, bytes) {
    if (rel !== apiPath || !verified) return write.call(this, rel, bytes);
    verified = false;
    if (event === '写盘失败') throw new Error('测试磁盘写入失败');
    await write.call(this, rel, bytes);
    if (event === '取消') controller.abort();
    else if (event === '替换') await artifacts.writeYaml(apiPath, catalog({ unverified: operation(fake) }));
    else {
      const approvals = await Approvals.load(artifacts);
      approvals.approve('profile', apiName, await payload(artifacts, apiName), '并发人工');
      await approvals.save(artifacts);
    }
  });
  const code = await init({}, controller.signal);
  expect(code).toBe(event === '写盘失败' ? 3 : 2);
  const approvals = await Approvals.load(artifacts);
  expect(approvals.record('profile', apiName)?.by).toBe(event === '人工确认' ? '并发人工' : undefined);
  const expected = event === '替换' ? { unverified: { ...operation(fake), knowledge: [] } }
    : event === '写盘失败' ? { catalog_marker: { ...operation(), knowledge: [] }, fake: { ...operation(fake), knowledge: [] } }
    : { catalog_marker: { ...operation(), knowledge: [] } };
  expect(await payload(artifacts, apiName)).toEqual(catalog(expected));
  if (event === '取消') expect(approvals.record('profile', 'pages.yaml')).toBeUndefined();
});

it.each(['取消', '人工确认'] as const)('笔记写盘后%s，保留完整笔记但不以 auto 覆盖', async (event) => {
  const { artifacts, init } = await project();
  const controller = new AbortController();
  const write = ArtifactStore.prototype.writeBytes;
  vi.spyOn(ArtifactStore.prototype, 'writeBytes').mockImplementation(async function (this: ArtifactStore, rel, bytes) {
    await write.call(this, rel, bytes);
    if (rel !== 'notes.md') return;
    if (event === '取消') controller.abort();
    else {
      const approvals = await Approvals.load(artifacts);
      approvals.approve('notes', 'project', Buffer.from(bytes).toString(), '并发人工');
      await approvals.save(artifacts);
    }
  });
  expect(await init({}, controller.signal)).toBe(2);
  expect((await artifacts.readBytes('notes.md'))?.toString()).toBe('# 项目笔记\n\n扫描结果');
  expect((await Approvals.load(artifacts)).record('notes', 'project')?.by).toBe(event === '人工确认' ? '并发人工' : undefined);
  expect(await artifacts.list('system')).toEqual([]);
});
