import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover, staticScanPlugin } from '../src/index';
import { sanitize, sanitizeMultiline } from '../src/sanitize';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'static-scan-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const scan = () => discover({ projectRoot: root, plugins: [staticScanPlugin] });

describe('静态扫描', () => {
  it('整段清理 YAML 块标量、跨行引号及 Markdown 示例，保持行数', () => {
    const text = ['# 配置', '```yaml', 'password: |-', '  first-secret', '  second-secret', 'safe: yes', 'api_key: >', '  folded-secret', '  more-secret', 'token: "first-line', '  second-line-secret', '  last-secret"', 'authorization: Bearer direct-secret', 'url: https://user:url-secret@example.com/?key=query-secret', '```', '保留普通文字'].join('\n');
    const cleaned = sanitizeMultiline(text);
    for (const secret of ['first-secret', 'second-secret', 'folded-secret', 'more-secret', 'first-line', 'second-line-secret', 'last-secret', 'direct-secret', 'url-secret', 'query-secret']) expect(cleaned).not.toContain(secret);
    expect(cleaned.split('\n')).toHaveLength(text.split('\n').length);
    expect(cleaned).toContain('safe: yes');
    expect(cleaned).toContain('保留普通文字');
  });

  it.each(['|2-', '|+2', '>3+', '>-3', '', 'plain-first'])('敏感字段 %s 的缩进续行不会泄漏', (indicator) => {
    const text = `password: ${indicator}\n  continuation-secret\n  nested-secret\nsafe: yes`;
    const cleaned = sanitizeMultiline(text);
    expect(cleaned).not.toMatch(/continuation-secret|nested-secret|plain-first/);
    expect(cleaned).toContain('safe: yes');
    expect(cleaned.split('\n')).toHaveLength(4);
  });

  it.each([
    'https://example.test/?payload=["first-secret","tail-sensitive"]',
    '前缀 "https://example.test/?payload=["first-secret","tail-sensitive"]" 后缀',
    '//example.test/?payload=["first-secret","tail-sensitive"]',
  ])('清理含引号查询参数的完整 URL：%s', (text) => {
    expect(sanitizeMultiline(text)).not.toMatch(/first-secret|tail-sensitive/);
  });

  it('未闭合多行敏感值时保守清除余下文本', () => {
    const text = 'password: "one-secret\nstill-secret\nend-secret';
    expect(sanitizeMultiline(text)).not.toMatch(/one-secret|still-secret|end-secret/);
  });
  it('读取有限清单并保留真实来源，不执行脚本，不读取真实环境文件', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'shop', scripts: { dev: 'node server.js', danger: 'node -e "require(\'fs\').writeFileSync(\'marker\',\'x\')"' }, dependencies: { express: '5' } }, null, 2));
    await writeFile(join(root, 'README.md'), '# 项目\n运行 npm start\n');
    await writeFile(join(root, 'pom.xml'), '<project>\n<artifactId>shop-java</artifactId>\n<parent><artifactId>spring-boot-starter-parent</artifactId></parent>\n</project>');
    await writeFile(join(root, 'compose.yaml'), 'services:\n  web:\n    ports:\n      - "8080:80"\n      - target: 443\n        published: 8443\n');
    await writeFile(join(root, '.env.example'), 'PORT=3000\nPORT=4000\nAPI_KEY=secret-env-value\n');
    await writeFile(join(root, '.env'), 'PRIVATE_REAL_ENV=never-read\n');
    const r = await scan();
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'command', name: 'dev', command: 'node server.js', source: expect.objectContaining({ file: 'package.json', line: 4 }) }));
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'project', ecosystem: 'npm', name: 'shop' }));
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'project', ecosystem: 'node:express', name: 'shop' }));
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'command', name: 'README:2', command: '运行 npm start', source: { file: 'README.md', line: 2, excerpt: '运行 npm start' } }));
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'project', ecosystem: 'maven', name: 'shop-java' }));
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'project', ecosystem: 'spring-boot', name: 'shop-java' }));
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'port', service: 'web', port: 8080, source: expect.objectContaining({ file: 'compose.yaml', line: 4 }) }));
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'port', service: 'web', port: 8443 }));
    expect(r.facts.filter(f => f.kind === 'environment-variable').map(f => f.name)).toEqual(['PORT', 'API_KEY']);
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'environment-variable', name: 'API_KEY', source: { file: '.env.example', line: 3, excerpt: 'API_KEY=[已隐藏]' } }));
    expect(JSON.stringify(r)).not.toMatch(/secret-env-value|PRIVATE_REAL_ENV|never-read/);
    await expect(access(join(root, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await scan()).toEqual(r);
  });

  it('命令与来源均隐藏凭证及 URL 用户信息、查询和片段', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'TOKEN=abc123 node app --password pass123 --token=tok123 https://user:pw@example.com/path?key=xyz#frag' } }, null, 2));
    await writeFile(join(root, 'README.md'), '启动 API_KEY=readsecret npm start https://u:p@example.org/a?q=secret#hidden\n');
    const r = await scan();
    const text = JSON.stringify(r);
    expect(r.facts.filter(f => f.kind === 'command')).toHaveLength(2);
    expect(text).toContain('https://example.com/path');
    expect(text).toContain('https://example.org/a');
    expect(text).not.toMatch(/abc123|pass123|tok123|user:pw|key=xyz|frag|readsecret|u:p|q=secret|hidden/);
  });

  it('非法文件各自隔离，重复 YAML 键、变量端口和 XML 实体只诊断', async () => {
    await writeFile(join(root, 'package.json'), '{"name": "leak-json-secret",');
    await writeFile(join(root, 'compose.yaml'), 'services:\n  web:\n    ports: ["${PORT}:80"]\n  web:\n    ports: ["1234:80"]\n# yaml-secret\n');
    await writeFile(join(root, 'docker-compose.yml'), 'services:\n  api:\n    ports:\n      - "${PORT}:80"\n      - "3000:80"\n');
    await writeFile(join(root, 'pom.xml'), '<!DOCTYPE project [<!ENTITY x SYSTEM "file:///secret">]><project><artifactId>&x;</artifactId></project>');
    await writeFile(join(root, '.env.example'), 'GOOD=ok\nINVALID-NAME=value\n');
    const r = await scan();
    expect(r.diagnostics.map(d => d.file)).toEqual(expect.arrayContaining(['package.json', 'compose.yaml', 'docker-compose.yml', 'pom.xml']));
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'port', service: 'api', port: 3000 }));
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'environment-variable', name: 'GOOD' }));
    expect(r.facts.filter(f => f.kind === 'port')).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/leak-json-secret|yaml-secret|file:\/\/\/secret|INVALID-NAME/);
  });

  it('结构化字段的来源对应真实行且不得泄漏其他字段中的秘密', async () => {
    await writeFile(join(root, 'package.json'), '{\n  "name": "demo",\n  "scripts": { "dev": "TOKEN=abc node app", "other": "safe" },\n  "password": "json-secret"\n}');
    await writeFile(join(root, 'compose.yaml'), 'services:\n  first:\n    ports: ["3000:80"]\n  second:\n    ports: ["3000:80"]\n');
    const r = await scan();
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'command', name: 'dev', source: expect.objectContaining({ file: 'package.json', line: 3, excerpt: expect.stringContaining('"dev"') }) }));
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'port', service: 'second', port: 3000, source: expect.objectContaining({ line: 5 }) }));
    expect(JSON.stringify(r)).not.toMatch(/abc|json-secret/);
  });

  it('不会从 compose 端口所在行泄漏备注中的凭证', async () => {
    await writeFile(join(root, 'compose.yaml'), 'services:\n  web:\n    ports:\n      - "3000:80" # password: compose-secret\n');
    const r = await scan();
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'port', port: 3000 }));
    expect(JSON.stringify(r)).not.toContain('compose-secret');
  });

  it('跳过缺少项目自身 artifactId 的 pom，不把依赖误当项目', async () => {
    await writeFile(join(root, 'pom.xml'), '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>');
    const r = await scan();
    expect(r.facts.filter(f => f.kind === 'project')).toEqual([]);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ file: 'pom.xml' }));
  });

  it('去除引号包围键的冒号凭证，包括命令及来源', async () => {
    expect(sanitize('{"password":"hunter2", "token": "secret-token"}')).not.toMatch(/hunter2|secret-token/);
    await writeFile(join(root, 'README.md'), '启动 {"password":"hunter2"}\n');
    await writeFile(join(root, 'compose.yaml'), 'services:\n  web:\n    ports:\n      - "3000:80" # {"password":"composepass"}\n');
    const r = await scan();
    expect(r.facts.filter(f => f.kind === 'command')).toHaveLength(1);
    expect(r.facts.filter(f => f.kind === 'port')).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/hunter2|composepass/);
  });

  it('脚本里的转义 JSON 凭证也不得泄漏', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'node app --config \'{"password":"very-secret"}\'' } }, null, 2));
    const r = await scan();
    expect(r.facts.filter(f => f.kind === 'command')).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('very-secret');
  });

  it('package 同名键根据所属对象定位而不是全文首次出现', async () => {
    await writeFile(join(root, 'package.json'), '{\n  "name": "dev",\n  "description": "express",\n  "scripts": {\n    "dev": "node app"\n  },\n  "dependencies": {\n    "express": "5"\n  }\n}');
    const r = await scan();
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'command', name: 'dev', source: expect.objectContaining({ line: 5 }) }));
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'project', ecosystem: 'node:express', source: expect.objectContaining({ line: 8 }) }));
  });

  it('compose 短语法两端都必须是有效端口', async () => {
    await writeFile(join(root, 'compose.yaml'), 'services:\n  web:\n    ports:\n      - "8080:${PORT}"\n      - "8081:not-a-port"\n      - "8082:70000"\n      - "8083:80/tcp"\n');
    const r = await scan();
    expect(r.facts.filter(f => f.kind === 'port')).toEqual([expect.objectContaining({ port: 8083 })]);
    expect(r.diagnostics.filter(d => d.file === 'compose.yaml')).toHaveLength(3);
  });

  it.each([
    ['越界 target', '{target: 70000, published: 8080}'],
    ['变量 target', "{target: '${PORT}', published: 8080}"],
    ['缺失 target', '{published: 8080}'],
    ['零 target', '{target: 0, published: 8080}'],
    ['小数 target', '{target: 80.5, published: 8080}'],
    ['未知 target', '{target: {value: 80}, published: 8080}'],
    ['空 published', '{target: 80, published: null}'],
    ['变量 published', "{target: 80, published: '${PORT}'}"],
    ['越界 published', '{target: 80, published: 70000}'],
    ['未知 published', '{target: 80, published: [8080]}'],
  ])('compose 长语法的%s 诊断跳过，不用另一端冒充有效端口', async (_name, entry) => {
    await writeFile(join(root, 'compose.yaml'), `services:\n  web:\n    ports:\n      - ${entry} # secret-invalid-port\n      - {target: 443, published: '8443'}\n      - {target: '65535'}\n      - {target: 1, published: 65535}\n`);
    const r = await scan();
    expect(r.facts.filter(f => f.kind === 'port')).toEqual([
      expect.objectContaining({ port: 8443 }),
      expect.objectContaining({ port: 65535 }),
      expect.objectContaining({ port: 65535 }),
    ]);
    expect(r.diagnostics).toEqual([{ plugin: 'static', file: 'compose.yaml', message: '文件格式无效或包含不支持的内容' }]);
    expect(JSON.stringify(r)).not.toContain('secret-invalid-port');
  });

  it('compose 短长语法来源定位实际 ports 项而非注释或其他字段', async () => {
    await writeFile(join(root, 'compose.yaml'), `services:\n  web:\n    # 3000:80\n    ports:\n      - "3000:80"\n      - target: 443\n        published: 8443\n  api:\n    labels: {published: 9443}\n    ports:\n      - {target: 443, published: 9443}\n      - "3000:80"\n`);
    const r = await scan();
    expect(r.diagnostics).toEqual([]);
    expect(r.facts).toEqual([
      expect.objectContaining({ kind: 'port', service: 'web', port: 3000, source: { file: 'compose.yaml', line: 5, excerpt: '- "3000:80"' } }),
      expect.objectContaining({ kind: 'port', service: 'web', port: 8443, source: { file: 'compose.yaml', line: 6, excerpt: '- target: 443' } }),
      expect.objectContaining({ kind: 'port', service: 'api', port: 9443, source: { file: 'compose.yaml', line: 11, excerpt: '- {target: 443, published: 9443}' } }),
      expect.objectContaining({ kind: 'port', service: 'api', port: 3000, source: { file: 'compose.yaml', line: 12, excerpt: '- "3000:80"' } }),
    ]);
  });

  it('不把不良构的 pom 当作有效项目，其他文件继续扫描', async () => {
    await writeFile(join(root, 'pom.xml'), '<project><artifactId>shop</artifactId><broken></project>');
    await writeFile(join(root, '.env.example'), 'PORT=80\n');
    const r = await scan();
    expect(r.facts.filter(f => f.kind === 'project')).toEqual([]);
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'environment-variable', name: 'PORT' }));
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ file: 'pom.xml' }));
  });

  it('引号凭证值中的转义引号不会导致后续秘密泄漏', async () => {
    const value = String.raw`{"password":"abc\"LEAK"}`;
    expect(sanitize(value)).not.toMatch(/abc|LEAK/);
    await writeFile(join(root, 'README.md'), `启动 ${value}\n`);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: `node app '${value}'` } }, null, 2));
    const r = await scan();
    expect(r.facts.filter(f => f.kind === 'command')).toHaveLength(2);
    expect(JSON.stringify(r)).not.toMatch(/abc|LEAK/);
  });

  it.each([
    String.raw`PASSWORD="abc\"LEAK" npm start`,
    String.raw`npm start --password "abc\"LEAK"`,
    String.raw`npm start --password="abc\"LEAK"`,
    String.raw`PASSWORD='abc\'LEAK' npm start`,
    String.raw`npm start --password 'abc\'LEAK'`,
    String.raw`PASSWORD=\"abc\\\"LEAK\" npm start`,
    String.raw`npm start --password \"abc\\\"LEAK\"`,
  ])('赋值及 CLI 转义凭证完整脱敏 %#', command => {
    expect(sanitize(command)).not.toMatch(/abc|LEAK/);
  });

  it.each([
    String.raw`PASSWORD="abc\"LEAK" npm start`,
    String.raw`npm start --password "abc\"LEAK"`,
    String.raw`npm start --password="abc\"LEAK"`,
    String.raw`PASSWORD='abc\'LEAK' npm start`,
    String.raw`npm start --password 'abc\'LEAK'`,
    String.raw`PASSWORD=\"abc\\\"LEAK\" npm start`,
    String.raw`npm start --password \"abc\\\"LEAK\"`,
  ])('扫描转义凭证时完整结果和实际来源均不泄漏 %#', async command => {
    await writeFile(join(root, 'README.md'), `启动 ${command}\n`);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: command } }, null, 2));
    const r = await scan();
    expect(r.diagnostics).toEqual([]);
    expect(r.facts.filter(f => f.kind === 'command')).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ file: 'README.md', line: 1 }) }),
      expect.objectContaining({ source: expect.objectContaining({ file: 'package.json', line: 4 }) }),
    ]);
    expect(JSON.stringify(r.facts.map(fact => fact.source))).not.toMatch(/abc|LEAK/);
    expect(JSON.stringify(r)).not.toMatch(/abc|LEAK/);
  });

  it.each([
    '<?xml nope?><project><artifactId>shop</artifactId></project>',
    '<?xml version="1.1"?><project><artifactId>shop</artifactId></project>',
    '<project><artifactId>shop</artifactId><x>&#0;</x></project>',
    '<project value="&#xD800;"><artifactId>shop</artifactId></project>',
    '<project><artifactId>shop</artifactId><x>&#x110000;</x></project>',
    '<project><artifactId>shop</artifactId><x>\u0000</x></project>',
  ])('拒绝不支持的声明或非法字符引用 %#', async (pom) => {
    await writeFile(join(root, 'pom.xml'), pom);
    await writeFile(join(root, '.env.example'), 'PORT=80\n');
    const r = await scan();
    expect(r.facts.filter(f => f.kind === 'project')).toEqual([]);
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'environment-variable', name: 'PORT' }));
    expect(r.diagnostics).toContainEqual({ plugin: 'static', file: 'pom.xml', message: '文件格式无效或包含不支持的内容' });
  });

  it.each([
    '<?xml version="1.0"?><project><artifactId>shop</artifactId></project>',
    '<?xml version ="1.0"?><project><artifactId>shop</artifactId></project>',
    '<project name="demo"><artifactId>shop</artifactId></project>',
    '<project name ="demo"><artifactId>shop</artifactId></project>',
    '<project><artifactId>shop</artifactId></project >',
    ' <project><artifactId>shop</artifactId></project>',
  ])('XML 语法位置拒绝非 XML 空白 %#', async pom => {
    await writeFile(join(root, 'pom.xml'), pom);
    const r = await scan();
    expect(r.facts.filter(f => f.kind === 'project')).toEqual([]);
    expect(r.diagnostics).toContainEqual({ plugin: 'static', file: 'pom.xml', message: '文件格式无效或包含不支持的内容' });
  });

  it('声明和标签接受 XML 定义的四种空白', async () => {
    await writeFile(join(root, 'pom.xml'), '<?xml\tversion\r=\n"1.0" encoding="UTF-8" ?><project\tname = "demo"><artifactId>shop</artifactId></project\n>');
    const r = await scan();
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'project', ecosystem: 'maven', name: 'shop' }));
    expect(r.diagnostics).toEqual([]);
  });

  it('接受受支持的 XML 1.0 声明与合法字符引用', async () => {
    await writeFile(join(root, 'pom.xml'), '<?xml version="1.0" encoding="UTF-8"?><project><artifactId>shop</artifactId><x>&#9;&#x1F600;&amp;</x></project>');
    const r = await scan();
    expect(r.facts).toContainEqual(expect.objectContaining({ kind: 'project', ecosystem: 'maven', name: 'shop' }));
    expect(r.diagnostics).toEqual([]);
  });

  it('取消信号透传且不转为普通诊断', async () => {
    const controller = new AbortController();
    controller.abort(new Error('主动取消'));
    await expect(discover({ projectRoot: root, plugins: [staticScanPlugin], signal: controller.signal })).rejects.toThrow('主动取消');
    const during = new AbortController();
    await expect(staticScanPlugin.scan({ signal: during.signal, files: { async readText() { during.abort(new Error('读取中取消')); throw new Error('读取失败'); } } })).rejects.toThrow('读取中取消');
  });
});
