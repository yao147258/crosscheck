import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover, openApiPlugin } from '../src/index';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'openapi-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function scan(text: string, name = 'api.yaml') {
  await writeFile(join(root, name), text);
  return discover({ projectRoot: root, plugins: [openApiPlugin([name])] });
}

describe('OpenAPI 本地发现', () => {
  it('解析 YAML 参数覆盖、服务器优先级、真实行号及去敏', async () => {
    const result = await scan(`openapi: 3.0.3
servers:
  - url: https://root.example/v1
paths:
  /items/{id}:
    parameters:
      - $ref: '#/components/parameters/Id'
      - {name: q, in: query, required: false, schema: {type: string}}
    servers: [{url: 'https://path.example'}]
    get:
      summary: '查看 https://user:secret@example.com/a?token=abc'
      servers: [{url: 'https://user:pass@{host}/api?token=secret#frag', variables: {host: {default: api.example}}}]
      parameters:
        - {name: q, in: query, required: true, schema: {type: integer}}
components:
  parameters:
    Id: {name: id, in: path, required: true, schema: {type: string}}
`);
    expect(result.diagnostics).toEqual([]);
    expect(result.facts).toEqual([expect.objectContaining({ kind: 'api', method: 'GET', path: '/items/{id}', parameters: [
      { name: 'id', in: 'path', required: true, type: 'string' },
      { name: 'q', in: 'query', required: true, type: 'integer' },
    ], servers: ['https://api.example/api'], source: { file: 'api.yaml', line: 10, excerpt: 'get:' } })]);
    expect(JSON.stringify(result)).not.toMatch(/secret|user:pass|token=abc/);
  });
  it('解析 Swagger 2 JSON、basePath 和 3.1 局部 schema 引用', async () => {
    const swagger = await scan(JSON.stringify({ swagger: '2.0', basePath: '/v2', paths: { '/pets': { post: { parameters: [{ name: 'body', in: 'body', required: false, schema: { type: 'object' } }] } } } }), 'api.json');
    expect(swagger.facts).toEqual([expect.objectContaining({ method: 'POST', servers: ['/v2'], parameters: [{ name: 'body', in: 'body', required: false, type: 'object' }] })]);
    const v31 = await scan(`openapi: 3.1.0\npaths:\n  /x:\n    get:\n      parameters:\n        - name: q\n          in: query\n          schema: {$ref: '#/components/schemas/T'}\ncomponents:\n  schemas:\n    T: {type: integer}\n`);
    expect(v31.facts).toEqual([expect.objectContaining({ parameters: [{ name: 'q', in: 'query', required: false, type: 'integer' }] })]);
  });
  it('外部引用不读取、不联网，并跳过不完整操作', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const read = vi.fn(async (file: string) => file === 'api.yaml' ? `openapi: 3.0.3\npaths:\n  /x:\n    get:\n      parameters: [{$ref: 'https://example.com/secret.yaml'}]\n` : 'secret');
    const result = await openApiPlugin(['api.yaml']).scan({ files: { readText: read } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.facts).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it.each([
    ['循环引用', `openapi: 3.0.0\npaths:\n  /x:\n    get:\n      parameters: [{$ref: '#/components/parameters/A'}]\ncomponents:\n  parameters:\n    A: {$ref: '#/components/parameters/A'}\n`],
    ['无效版本', 'openapi: 4.0.0\npaths: {}\n'],
    ['无效 paths', 'openapi: 3.0.0\npaths: []\n'],
    ['空服务器定义', 'openapi: 3.0.0\nservers: null\npaths: {/x: {get: {}}}\n'],
    ['路径含查询参数', 'openapi: 3.0.0\npaths: {"/x?token=secret": {get: {}}}\n'],
    ['无效参数', 'openapi: 3.0.0\npaths: {/x: {get: {parameters: [{name: q, in: query, required: wrong}]}}}\n'],
    ['缺少模板参数', 'openapi: 3.0.0\npaths: {"/x/{id}": {get: {}}}\n'],
    ['额外模板参数', 'openapi: 3.0.0\npaths: {/x: {get: {parameters: [{name: id, in: path, required: true}]}}}\n'],
    ['不支持的方法', 'openapi: 3.0.0\npaths: {/x: {connect: {}}}\n'],
    ['畸形 YAML', 'openapi: 3.0.0\npaths: [oops\n'],
    ['原型引用', "openapi: 3.0.0\npaths: {/x: {get: {parameters: [{$ref: '#/constructor'}]}}}\n"],
  ])('%s 应诊断且不生成事实', async (_name, text) => {
    const result = await scan(text);
    expect(result.facts).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it('解析局部 path item 引用并定位原始引用行', async () => {
    const result = await scan(`openapi: 3.0.3\npaths:\n  /x:\n    $ref: '#/components/pathItems/X'\ncomponents:\n  pathItems:\n    X:\n      get: {summary: 参考接口}\n`);
    expect(result.facts).toEqual([expect.objectContaining({ method: 'GET', source: { file: 'api.yaml', line: 4, excerpt: "$ref: '#/components/pathItems/X'" } })]);
  });
  it('保留普通接口路径中间的双斜杠', async () => {
    const result = await scan(`openapi: 3.0.3\npaths:\n  /api//users:\n    get: {}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.facts).toEqual([expect.objectContaining({ path: '/api//users' })]);
  });
  it('路径中的协议相对地址不泄漏用户信息', async () => {
    const result = await scan(`openapi: 3.0.3\npaths:\n  '//user:secret@example.com/items':\n    get: {}\n`);
    expect(JSON.stringify(result)).not.toContain('secret');
    if (result.facts.length) expect(result.facts[0]).toEqual(expect.objectContaining({ path: '//example.com/items' }));
    else expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it.each(['yaml', 'json'])('拒绝路径内部含 userinfo 的 %s 接口，完整结果和来源不泄密且普通双斜杠保真', async format => {
    const data = { openapi: '3.0.3', paths: { '/api//user:secret@example.com/items': { get: {} }, '/api//users': { get: {} } } };
    const text = format === 'json' ? JSON.stringify(data) : `openapi: 3.0.3\npaths:\n  '/api//user:secret@example.com/items': {get: {}}\n  /api//users:\n    get: {}\n`;
    const result = await scan(text, `api.${format}`);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result.facts.map(fact => fact.source))).not.toContain('secret');
    expect(JSON.stringify(result.facts.map(fact => fact.source))).not.toContain('/api//users/');
    expect(result.facts).toEqual([expect.objectContaining({ path: '/api//users', source: expect.objectContaining({ line: format === 'json' ? 1 : 5 }) })]);
    expect(result.diagnostics).toEqual([{ plugin: 'openapi', file: `api.${format}`, message: 'OpenAPI 文件包含无效或不支持的内容' }]);
  });
  it.each([3, 4, 5])('路径中含 %d 条连续斜杠的 userinfo 不会通过同一行的其它接口来源泄漏', async slashes => {
    const malicious = `/api${'/'.repeat(slashes)}user:secret@example.com/items`;
    const data = { openapi: '3.0.3', paths: { [malicious]: { get: {} }, '/api//users': { get: {} } } };
    const result = await scan(JSON.stringify(data), 'api.json');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result.facts.map(fact => fact.source))).not.toContain('secret');
    expect(JSON.stringify(result.facts.map(fact => fact.source))).not.toContain('/api//users/');
    expect(result.facts).toEqual([expect.objectContaining({ path: '/api//users' })]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it('path 中转义写法的斜杠（\\/）不会绕过 userinfo 清理而经同一行的其它接口来源泄漏', async () => {
    const text = `{"openapi":"3.0.3","paths":{"/api\\/\\/user:secret@example.com/items":{"get":{}},"/api//users":{"get":{}}}}`;
    const result = await scan(text, 'api.json');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.facts).toEqual([expect.objectContaining({ path: '/api//users' })]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it('servers 中 JSON 转义斜杠写法的 URL 不会经同一行来源摘录泄漏凭证', async () => {
    const text = `{"openapi":"3.0.3","servers":[{"url":"https:\\/\\/user:secret@example.com\\/api"}],"paths":{"\\/x":{"get":{}}}}`;
    const result = await scan(text, 'api.json');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.facts).toEqual([expect.objectContaining({ servers: ['https://example.com/api'] })]);
  });
  it('局部引用按 URI 片段解码后解析 JSON Pointer', async () => {
    const result = await scan(`openapi: 3.0.3\npaths:\n  /x:\n    get:\n      parameters: [{$ref: '#/components/parameters/user%20id'}]\ncomponents:\n  parameters:\n    'user id': {name: user, in: query}\n`);
    expect(result.diagnostics).toEqual([]);
    expect(result.facts).toEqual([expect.objectContaining({ parameters: [{ name: 'user', in: 'query', required: false }] })]);
  });
  it('非法 URI 片段编码产生诊断且不输出接口', async () => {
    const result = await scan(`openapi: 3.0.3\npaths: {/x: {get: {parameters: [{$ref: '#/components/%ZZ'}]}}}\n`);
    expect(result.facts).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it.each([
    ['operation', `openapi: 3.0.3\nservers: [{url: 'https://root.example'}]\npaths: {/x: {get: {servers: null}}}\n`],
    ['path', `openapi: 3.0.3\nservers: [{url: 'https://root.example'}]\npaths: {/x: {servers: null, get: {}}}\n`],
  ])('%s 层显式空服务器不回退', async (_level, text) => {
    const result = await scan(text);
    expect(result.facts).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it('相对网络地址服务器去除用户信息和查询片段', async () => {
    const result = await scan(`openapi: 3.0.3\nservers: [{url: '//user:secret@example.com/api?token=secret#x'}]\npaths: {/x: {get: {}}}\n`);
    expect(result.facts).toEqual([expect.objectContaining({ servers: ['//example.com/api'] })]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('服务器变量缺省值缺失时跳过操作', async () => {
    const result = await scan(`openapi: 3.0.3\nservers: [{url: 'https://{host}/api', variables: {host: {}}}]\npaths: {/x: {get: {}}}\n`);
    expect(result.facts).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it('传播取消并跳过缺失和重复文件', async () => {
    const abort = new AbortController();
    const readText = vi.fn(async () => { abort.abort(new Error('已取消')); return undefined; });
    await expect(openApiPlugin(['a']).scan({ files: { readText }, signal: abort.signal })).rejects.toThrow('已取消');
    const reader = vi.fn(async () => undefined);
    const result = await openApiPlugin(['missing', 'missing']).scan({ files: { readText: reader } });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ facts: [], diagnostics: [] });
  });
});
