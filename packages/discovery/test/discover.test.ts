import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover, type DiscoveryFact, type DiscoveryPlugin } from '../src/index';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'discovery-scan-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('插件执行', () => {
  it('按顺序运行插件并合并事实和诊断', async () => {
    await writeFile(join(root, 'README.md'), '项目');
    const events: string[] = [];
    const plugins: DiscoveryPlugin[] = [
      { id: 'first', async scan({ files }) {
        events.push('first');
        const text = await files.readText('README.md');
        return { facts: [{ kind: 'command', plugin: 'first', source: { file: 'README.md', line: 1, excerpt: text! }, name: 'start', command: 'npm start' }], diagnostics: [] };
      } },
      { id: 'second', async scan() { events.push('second'); return { facts: [], diagnostics: [{ plugin: 'second', message: '诊断' }] }; } },
    ];
    const result = await discover({ projectRoot: root, plugins });
    expect(events).toEqual(['first', 'second']);
    expect(result.facts).toEqual([{ kind: 'command', plugin: 'first', source: { file: 'README.md', line: 1, excerpt: '项目' }, name: 'start', command: 'npm start' }]);
    expect(result.diagnostics).toEqual([{ plugin: 'second', message: '诊断' }]);
  });
  it('消费者可按事实类型读取项目、命令、端口和环境变量字段', async () => {
    const source = { file: 'package.json', line: 1, excerpt: '项目清单' };
    const plugin: DiscoveryPlugin = { id: 'static', async scan() {
      const facts: DiscoveryFact[] = [
        { kind: 'project', plugin: 'static', source, ecosystem: 'node', name: 'demo' },
        { kind: 'command', plugin: 'static', source, name: 'dev', command: 'node server.js' },
        { kind: 'port', plugin: 'static', source, port: 3000, service: 'web' },
        { kind: 'environment-variable', plugin: 'static', source, name: 'PORT' },
      ];
      return { facts, diagnostics: [] };
    } };
    const result = await discover({ projectRoot: root, plugins: [plugin] });
    const descriptions = result.facts.map((fact) => {
      switch (fact.kind) {
        case 'project': return `${fact.ecosystem}:${fact.name}`;
        case 'command': return `${fact.name}:${fact.command}`;
        case 'port': return `${fact.service ?? '默认'}:${fact.port}`;
        case 'environment-variable': return fact.name;
        case 'api': return `${fact.method} ${fact.path}`;
      }
    });
    expect(descriptions).toEqual(['node:demo', 'dev:node server.js', 'web:3000', 'PORT']);
  });
  it('执行前拒绝重复插件 ID', async () => {
    let called = false;
    const plugin: DiscoveryPlugin = { id: 'same', async scan() { called = true; return { facts: [], diagnostics: [] }; } };
    await expect(discover({ projectRoot: root, plugins: [plugin, plugin] })).rejects.toThrow();
    expect(called).toBe(false);
  });
  it('将普通异常转为不泄漏异常正文的诊断并继续', async () => {
    const result = await discover({ projectRoot: root, plugins: [
      { id: 'broken', async scan() { throw new Error('秘密令牌'); } },
      { id: 'next', async scan() { return { facts: [], diagnostics: [{ plugin: 'next', message: '继续' }] }; } },
    ] });
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[0]?.plugin).toBe('broken');
    expect(JSON.stringify(result)).not.toContain('秘密令牌');
    expect(result.diagnostics[1]?.message).toBe('继续');
  });
  it('执行前和插件执行期间的取消均向上传播', async () => {
    const before = new AbortController(); before.abort(new Error('提前取消'));
    await expect(discover({ projectRoot: root, plugins: [], signal: before.signal })).rejects.toThrow('提前取消');
    const during = new AbortController();
    await expect(discover({ projectRoot: root, signal: during.signal, plugins: [{ id: 'abort', async scan() {
      during.abort(new Error('执行取消'));
      throw new Error('插件异常');
    } }] })).rejects.toThrow('执行取消');
  });
});
