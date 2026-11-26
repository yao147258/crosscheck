import { mkdtemp, mkdir, realpath, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createUsageObserver, makeUsageEvent, projectUsageLocation, readUsage } from '../src/usage-ledger';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, realpath: vi.fn(fs.realpath) };
});

const price = { inputPerMTok: 10, outputPerMTok: 20, cacheReadPerMTok: 2, cacheWritePerMTok: 5 };
const options = { project: '.', sessionId: null, command: 'chat' as const, role: 'planner' as const, pricing: { 'p:m': price, 'p:m[1M]': { ...price, inputPerMTok: 11 } }, warn: () => {} };
const complete = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 10 };

const attempt = { ref: 'p:m', status: 'success' as const, purpose: 'request' as const, usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };

async function withHome(run: (home: string, project: string) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), 'usage-ledger-'));
  try { const project = path.join(home, 'project'); await mkdir(project); await run(home, project); }
  finally { await rm(home, { recursive: true, force: true }); }
}

describe('账本持久化和汇总', () => {
  it('并发独立写入并按会话、命令、角色及模型汇总已知和未知部分', async () => withHome(async (home, project) => {
    const a = createUsageObserver({ ...options, home, project, sessionId: 'a' });
    const b = createUsageObserver({ ...options, home, project, sessionId: 'b', command: 'run', role: 'executor' });
    await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b)(attempt)));
    await b({ ...attempt, ref: 'p:unknown', status: 'error', usage: null });
    const report = await readUsage({ home, project });
    expect(report.incomplete).toBe(false);
    expect(report.total).toEqual({ inputTokens: 300, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, cost: expect.closeTo(0.007), calls: 101, unknownCalls: 1 });
    expect(report.byCommand.chat?.calls).toBe(50);
    expect(report.byCommand.run?.calls).toBe(51);
    expect(report.byRole.executor?.unknownCalls).toBe(1);
    expect(report.byModel['p:m']?.calls).toBe(100);
    expect(report.byModel['p:unknown']?.unknownCalls).toBe(1);
    expect((await readUsage({ home, project, sessionId: 'a' })).total.calls).toBe(50);
    const { directory } = await projectUsageLocation(project, home);
    const files = await readdir(directory);
    expect(files).toHaveLength(101);
    const ids = await Promise.all(files.map(async file => JSON.parse(await readFile(path.join(directory, file), 'utf8')).id));
    expect(new Set(ids).size).toBe(101);
  }));

  it('损坏、错误版本、缺字段及临时文件均产生诊断且不丢弃有效事件', async () => withHome(async (home, project) => {
    await createUsageObserver({ ...options, home, project })(attempt);
    const { directory } = await projectUsageLocation(project, home);
    const validFile = (await readdir(directory))[0];
    if (!validFile) throw new Error('缺少有效账本事件');
    const event = JSON.parse(await readFile(path.join(directory, validFile), 'utf8'));
    await writeFile(path.join(directory, 'broken.json'), '{秘密');
    await writeFile(path.join(directory, 'missing.json'), JSON.stringify({ ...event, usage: undefined }));
    await writeFile(path.join(directory, 'version.json'), JSON.stringify({ ...event, version: 2 }));
    await writeFile(path.join(directory, 'partial.tmp'), '秘密');
    const report = await readUsage({ home, project, sessionId: '其他会话' });
    expect(report.total.calls).toBe(0);
    expect(report.incomplete).toBe(true);
    expect(report.diagnostics.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(report.diagnostics)).not.toContain('秘密');
    expect((await readUsage({ home, project })).total.calls).toBe(1);
  }));

  it('拒绝项目、时间、枚举、模型、token 与价格损坏的事件', async () => withHome(async (home, project) => {
    await createUsageObserver({ ...options, home, project })(attempt);
    const { directory } = await projectUsageLocation(project, home);
    const validFile = (await readdir(directory))[0];
    if (!validFile) throw new Error('缺少有效账本事件');
    const valid = JSON.parse(await readFile(path.join(directory, validFile), 'utf8'));
    const variants = [
      { projectKey: 'wrong' }, { time: '2026-02-30T00:00:00.000Z' }, { status: 'invalid' },
      { purpose: 'invalid' }, { command: 'invalid' }, { role: 'invalid' },
      { provider: 'other' }, { usage: { ...valid.usage, inputTokens: -1 } },
      { usage: { ...valid.usage, outputTokens: 1.5 } }, { price: { inputPerMTok: -1, outputPerMTok: 1 } },
      { cost: -1 }, { sessionId: 12 },
    ];
    await Promise.all(variants.map(async variant => {
      const id = randomUUID();
      await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ ...valid, ...variant, id }));
    }));
    const report = await readUsage({ home, project });
    expect(report.total.calls).toBe(1);
    expect(report.diagnostics).toHaveLength(variants.length);
  }));

  it.each([
    ['空价格却有费用', { price: null, cost: 0 }],
    ['非零有限费用不一致', { cost: 0.000071 }],
    ['已知费用被置空', { cost: null }],
    ['回执改变但费用未变', { usage: { ...attempt.usage, outputTokens: 3 } }],
    ['缺少回执却保留费用', { usage: { ...attempt.usage, cacheReadTokens: null } }],
  ] as const)('拒绝与价格和回执不一致的费用：%s', async (_name, variant) => withHome(async (home, project) => {
    const observer = createUsageObserver({ ...options, home, project });
    await observer(attempt);
    await observer({ ...attempt, ref: 'p:unknown' });
    const { directory, projectKey } = await projectUsageLocation(project, home);
    const invalid = { ...makeUsageEvent(options, projectKey, attempt), ...variant };
    await writeFile(path.join(directory, `${invalid.id}.json`), JSON.stringify(invalid));
    const report = await readUsage({ home, project });
    expect(report).toMatchObject({ total: { calls: 2, cost: 0.00007, unknownCalls: 1 }, incomplete: true });
    expect(report.diagnostics).toHaveLength(1);
  }));

  it.each(['事件顶层', 'usage', 'price'] as const)('拒绝 %s 的未声明字段', async (level) => withHome(async (home, project) => {
    await createUsageObserver({ ...options, home, project })(attempt);
    const { directory, projectKey } = await projectUsageLocation(project, home);
    const event = makeUsageEvent(options, projectKey, attempt);
    const extra = { undeclared: '秘密' };
    const invalid = level === '事件顶层' ? { ...event, ...extra } : { ...event, [level]: { ...event[level], ...extra } };
    await writeFile(path.join(directory, `${event.id}.json`), JSON.stringify(invalid));
    const report = await readUsage({ home, project });
    expect(report).toMatchObject({ total: { calls: 1 }, incomplete: true });
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics.join()).not.toContain('秘密');
  }));

  it('写入价格时只持久化允许的费用字段', async () => withHome(async (home, project) => {
    const configuredPrice = { ...price, undeclared: '秘密' };
    await createUsageObserver({ ...options, home, project, pricing: { 'p:m': configuredPrice } })(attempt);
    const { directory } = await projectUsageLocation(project, home);
    const [file] = await readdir(directory);
    if (!file) throw new Error('缺少账本事件');
    const event = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    expect(event.price).toEqual(price);
    expect(await readUsage({ home, project })).toMatchObject({ total: { calls: 1 }, incomplete: false });
  }));

  it('空账本正常；写入失败与警告函数异常不传播且不泄漏路径', async () => withHome(async (home, project) => {
    expect(await readUsage({ home, project })).toMatchObject({ total: { calls: 0, unknownCalls: 0 }, incomplete: false, diagnostics: [] });
    const badHome = path.join(home, '秘密'); await writeFile(badHome, 'x');
    const warnings: string[] = [];
    const observer = createUsageObserver({ ...options, home: badHome, project, warn: message => { warnings.push(message); throw new Error('秘密'); } });
    await expect(observer(attempt)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('秘密');
    const report = await readUsage({ home: badHome, project });
    expect(report.incomplete).toBe(true);
    expect(report.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain('秘密');
  }));

  it('两个 Node 子进程并发写入独立完整事件', async () => withHome(async (home, project) => {
    const bundle = path.join(home, 'ledger.mjs');
    await build({ entryPoints: [path.resolve('packages/models/src/usage-ledger.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm' });
    const script = `import { createUsageObserver } from ${JSON.stringify(pathToFileURL(bundle).href)}; const o = createUsageObserver({project: process.argv[1], home: process.argv[2], sessionId: null, command:'chat', role:'planner', pricing:{'p:m':{inputPerMTok:10,outputPerMTok:20}}, warn:()=>{throw Error('write failed')}}); await Promise.all(Array.from({length:30},()=>o({ref:'p:m',status:'success',purpose:'request',usage:{inputTokens:3,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0}})));`;
    const exec = promisify(execFile);
    await Promise.all([exec(process.execPath, ['--input-type=module', '-e', script, project, home]), exec(process.execPath, ['--input-type=module', '-e', script, project, home])]);
    const { directory } = await projectUsageLocation(project, home);
    const files = await readdir(directory);
    expect(files).toHaveLength(60);
    const events = await Promise.all(files.map(async file => JSON.parse(await readFile(path.join(directory, file), 'utf8'))));
    expect(new Set(events.map(event => event.id)).size).toBe(60);
    expect((await readUsage({ home, project })).total.calls).toBe(60);
  }));
});

describe('账本事件', () => {
  it('保留配置引用，按去后缀模型归组，价格精确优先且不重复计算缓存', () => {
    const event = makeUsageEvent(options, 'key', { ref: 'p:m[1M]', status: 'success', purpose: 'request', usage: complete });
    expect([event.configuredRef, event.provider, event.modelId]).toEqual(['p:m[1M]', 'p', 'm']);
    expect(event.price?.inputPerMTok).toBe(11);
    expect(event.cost).toBeCloseTo((70 * 11 + 20 * 2 + 10 * 5 + 10 * 20) / 1e6);
    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Date(event.time).toISOString()).toBe(event.time);
  });

  it('缺缓存回执或价格时费用未知，而不是零；失败全未知', () => {
    const a = makeUsageEvent(options, 'key', { ref: 'p:m[2M]', status: 'success', purpose: 'request', usage: { inputTokens: 0, outputTokens: 0 } });
    expect(a.price).toEqual(price); expect(a.cost).toBeNull(); expect(a.usage.cacheReadTokens).toBeNull();
    const b = makeUsageEvent(options, 'key', { ref: 'p:other', status: 'error', purpose: 'request', usage: null });
    expect(b.price).toBeNull(); expect(b.cost).toBeNull(); expect(b.usage.inputTokens).toBeNull();
  });

  it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('无效 token %s 保留为未知', (value) => {
    const event = makeUsageEvent(options, 'key', { ref: 'p:m', status: 'success', purpose: 'request', usage: { ...complete, inputTokens: value } });
    expect(event.usage.inputTokens).toBeNull(); expect(event.cost).toBeNull();
  });

  it('缓存之和超过输入时费用未知，明确零回执可计算', () => {
    const attempt = { ref: 'p:m', status: 'success' as const, purpose: 'request' as const };
    expect(makeUsageEvent(options, 'key', { ...attempt, usage: { ...complete, inputTokens: 29 } }).cost).toBeNull();
    expect(makeUsageEvent(options, 'key', { ...attempt, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }).cost).toBe(0);
  });

  it('缺省缓存价格使用输入价格，非法价格不可计算且不回退', () => {
    const attempt = { ref: 'p:m[1M]', status: 'success' as const, purpose: 'request' as const, usage: complete };
    const withoutCache = { ...options, pricing: { 'p:m': { inputPerMTok: 10, outputPerMTok: 20 } } };
    expect(makeUsageEvent(withoutCache, 'key', attempt).cost).toBeCloseTo(0.0012);
    for (const value of [-1, Infinity, NaN]) {
      const invalid = { ...options, pricing: { ...options.pricing, 'p:m[1M]': { ...price, inputPerMTok: value } } };
      const event = makeUsageEvent(invalid, 'key', attempt);
      expect(event.price).toBeNull(); expect(event.cost).toBeNull();
    }
  });

  it('价格是调用时快照', () => {
    const pricing = { 'p:m': { ...price } };
    const event = makeUsageEvent({ ...options, pricing }, 'key', { ref: 'p:m', status: 'success', purpose: 'request', usage: complete });
    pricing['p:m'].inputPerMTok = 999;
    expect(event.price?.inputPerMTok).toBe(10);
  });

  it('Windows 保留真实路径大小写差异，并合并 realpath 归一的别名', async () => withHome(async (home) => {
    const upper = path.join(home, 'Project');
    const lower = path.join(home, 'project');
    const alias = path.join(home, 'PROJECT');
    const platform = process.platform;
    const resolve = vi.mocked(realpath);
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      // 模拟大小写敏感目录，以及被文件系统解析为同一真实路径的普通别名。
      const paths = new Map([[upper, upper], [lower, lower], [alias, upper]]);
      resolve.mockImplementation(async input => {
        const canonical = paths.get(String(input));
        if (!canonical) throw new Error('未配置的真实路径');
        return canonical;
      });
      await createUsageObserver({ ...options, home, project: upper })(attempt);
      expect(await readUsage({ home, project: alias })).toMatchObject({ total: { calls: 1 }, incomplete: false });
      expect(await readUsage({ home, project: lower })).toMatchObject({ total: { calls: 0 }, incomplete: false });
    } finally {
      resolve.mockReset();
      Object.defineProperty(process, 'platform', { value: platform });
    }
  }));

  it('真实路径隔离项目，无法解析不回退成另一个项目', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'usage-home-'));
    try {
      const a = path.join(home, 'a'), b = path.join(home, 'b'); await mkdir(a); await mkdir(b);
      const location = await projectUsageLocation(a, home);
      expect(location.projectKey).toMatch(/^[0-9a-f]{64}$/);
      expect(location.directory).toBe(path.join(home, '.crosscheck', 'projects', location.projectKey, 'usage'));
      expect(location.projectKey).not.toBe((await projectUsageLocation(b, home)).projectKey);
      expect((await projectUsageLocation(path.join(a, '..', 'a'), home)).projectKey).toBe((await projectUsageLocation(await realpath(a), home)).projectKey);
      await expect(projectUsageLocation(path.join(home, 'missing'), home)).rejects.toThrow();
      if (process.platform !== 'win32') { const link = path.join(home, 'link'); await symlink(a, link); expect((await projectUsageLocation(link, home)).projectKey).toBe(location.projectKey); }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
