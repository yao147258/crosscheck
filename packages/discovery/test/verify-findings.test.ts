import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FindingSchema, verifyFindings, walkProject, type DiscoveryFact, type Finding } from '../src/index';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'verify-'));
  await mkdir(join(root, 'server'));
  await writeFile(join(root, 'server/users.controller.ts'), "@Controller('users')\nexport class Users {\n  @Get(':id')\n  find() {}\n}\n");
  await writeFile(join(root, 'package.json'), '{\n  "scripts": { "dev": "vite --port 5173" }\n}\n');
  await writeFile(join(root, '.env.example'), 'API_TOKEN=abc123\nDB_HOST=localhost\n');
  await writeFile(join(root, '.env'), 'API_TOKEN=real\n');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const src = (file: string, line: number, excerpt: string) => ({ file, line, excerpt });
const parse = (items: unknown[]): Finding[] => items.map((item) => FindingSchema.parse(item));
async function verify(findings: unknown[], facts: DiscoveryFact[] = []) {
  return verifyFindings({ projectRoot: root, files: (await walkProject(root)).files, findings: parse(findings), facts });
}

describe('verifyFindings', () => {
  it('来源行一致时通过，excerpt 规范化为整行原文，method 转大写', async () => {
    const result = await verify([{ kind: 'api', method: 'get', path: '/users/:id', summary: '查询用户', source: src('server/users.controller.ts', 3, "@Get(':id')") }]);
    expect(result.diagnostics).toEqual([]);
    expect(result.facts).toEqual([{ kind: 'api', plugin: 'agent', method: 'GET', path: '/users/:id', summary: '查询用户', parameters: [], servers: [], source: src('server/users.controller.ts', 3, "@Get(':id')") }]);
  });
  it('行号错位或原文不一致时丢弃并记诊断', async () => {
    const result = await verify([
      { kind: 'api', method: 'GET', path: '/users/:id', source: src('server/users.controller.ts', 2, "@Get(':id')") },
      { kind: 'page', path: '/users', source: src('server/users.controller.ts', 1, '虚构内容') },
    ]);
    expect(result.facts).toEqual([]);
    expect(result.diagnostics).toEqual([
      '发现来源核验失败已丢弃：api server/users.controller.ts:2',
      '发现来源核验失败已丢弃：page server/users.controller.ts:1',
    ]);
  });
  it('命令、端口、环境变量的值必须出现在来源行', async () => {
    const result = await verify([
      { kind: 'command', name: 'dev', command: 'vite --port 5173', source: src('package.json', 2, '"dev"') },
      { kind: 'command', name: 'build', command: 'vite build', source: src('package.json', 2, '"dev"') },
      { kind: 'port', port: 5173, service: 'web', source: src('package.json', 2, '5173') },
      { kind: 'port', port: 517, source: src('package.json', 2, '5173') },
      { kind: 'environment-variable', name: 'API_TOKEN', source: src('.env.example', 1, 'API_TOKEN') },
      { kind: 'environment-variable', name: 'DB', source: src('.env.example', 2, 'DB_HOST') },
    ]);
    expect(result.facts.map((fact) => fact.kind)).toEqual(['command', 'port', 'environment-variable']);
    expect(result.facts[2]!.source.excerpt).toBe('API_TOKEN=[已隐藏]');
    expect(JSON.stringify(result.facts)).not.toContain('abc123');
    expect(result.diagnostics).toHaveLength(3);
  });
  it('清单外、凭证与越界路径一律丢弃', async () => {
    const result = await verify([
      { kind: 'environment-variable', name: 'API_TOKEN', source: src('.env', 1, 'API_TOKEN') },
      { kind: 'page', path: '/x', source: src('../outside.ts', 1, 'x') },
    ]);
    expect(result.facts).toEqual([]);
    expect(result.diagnostics).toHaveLength(2);
  });
  it('与静态事实或彼此重复时只保留一份，静态事实优先', async () => {
    const existing: DiscoveryFact = { kind: 'port', plugin: 'static-scan', port: 5173, source: src('package.json', 2, '"dev": "vite --port 5173"') };
    const result = await verify([
      { kind: 'port', port: 5173, source: src('package.json', 2, '5173') },
      { kind: 'api', method: 'GET', path: '/users/:id', source: src('server/users.controller.ts', 3, '@Get') },
      { kind: 'api', method: 'get', path: '/users/:id', source: src('server/users.controller.ts', 3, '@Get') },
    ], [existing]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ kind: 'api' });
    expect(result.diagnostics).toEqual([]);
  });
  it('文件在探索后被修改时核验失败', async () => {
    const files = (await walkProject(root)).files;
    await writeFile(join(root, 'server/users.controller.ts'), '// 已重写\n');
    const result = await verifyFindings({ projectRoot: root, files, facts: [], findings: parse([{ kind: 'api', method: 'GET', path: '/users/:id', source: src('server/users.controller.ts', 3, '@Get') }]) });
    expect(result.facts).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });
});
