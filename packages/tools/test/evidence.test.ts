import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../../core/src/index';
import { EvidenceStore, sanitizeHar, sanitizeDom, createEvidenceRedactor } from '../src/index';

const secret = 'sentinel+secret/42';
const ctx = { runId: 'run-1', caseId: 'M-TC-1', attempt: 1 };
const meta = { actionId: 'a-1', phase: 'execution' as const };

describe('可信证据出口', () => {
  it('HAR 各字段安全清理且不修改原始输入', () => {
    const r = createEvidenceRedactor([], [secret]);
    const har = { log: { version: '1.2', creator: { name: 'test', version: '1' }, entries: [{ request: { method: 'POST', url: `/a?session=${secret}#/p?sid=${secret}`, headers: [{ name: 'Authorization', value: secret }], cookies: [{ name: 'sid', value: secret }], queryString: [{ name: 'session', value: secret }], postData: { mimeType: 'application/json', text: '{"password":"unknown",' } }, response: { status: 302, headers: [{ name: 'Location', value: `/x?token=${secret}` }], cookies: [{ name: 'auth', value: secret }], redirectURL: `/x?token=${secret}`, content: { mimeType: 'application/json', text: Buffer.from(JSON.stringify({ token: secret, ok: 1 })).toString('base64'), encoding: 'base64', size: 100 } } }] } };
    const original = JSON.stringify(har);
    const output = JSON.stringify(sanitizeHar(har, r));
    expect(JSON.stringify(har)).toBe(original);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(Buffer.from(JSON.stringify({ token: secret, ok: 1 })).toString('base64'));
    expect(output).not.toContain('unknown');
    expect(output).toContain('omitted');
  });
  it('最终修复 I2 展示JSON按叶子清洗转义的known secret且保留自然语言', () => {
    const dynamic = 'late"secret\\value'; const r = createEvidenceRedactor([], [dynamic]);
    const input = JSON.stringify({ ordinary: dynamic, nested: { url: '/reset?password=UNKNOWN_SECRET&mode=safe' }, password: 'JSON_SECRET', safe: '自然语言不是URL' });
    const clean = JSON.parse(r.displayText(input));
    expect(clean.ordinary).toBe('[REDACTED]'); expect(clean.password).toBe('[REDACTED]'); expect(clean.nested.url).not.toContain('UNKNOWN_SECRET'); expect(clean.nested.url).toContain('mode=safe'); expect(clean.safe).toBe('自然语言不是URL');
    expect(r.displayText('自然语言不是URL')).toBe('自然语言不是URL');
  });
  it.each(["'", '"', '`', '<', '>', '(),;!$:+/?', '%27', '%22%60%3C%3E'])('残留I2 URL边界%s保持嵌套JSON/quoted URL语义和自然语言', boundary => {
    const r = createEvidenceRedactor();
    const url = `https://example.invalid/reset?password=before${boundary}AFTER_SECRET_918&mode=safe`;
    const nested = JSON.parse(r.displayText(JSON.stringify({ url, nested: { note: `请检查 ${url} 然后继续`, encoded: JSON.stringify({ url, safe: '安全值' }) } })));
    expect(JSON.stringify(nested)).not.toContain('AFTER_SECRET_918');
    for (const clean of [nested.url, nested.nested.note, JSON.parse(nested.nested.encoded).url, r.displayText(`请检查 "${url}" 然后继续`), r.displayText(`请检查 '${url}' 然后继续`), r.displayText(`请检查 \`${url}\` 然后继续`)]) {
      expect(clean).not.toContain('AFTER_SECRET_918'); expect(clean).toContain('/reset'); expect(clean).toContain('mode=safe');
    }
    expect(nested.nested.note).toContain('请检查'); expect(nested.nested.note).toContain('然后继续'); expect(JSON.parse(nested.nested.encoded).safe).toBe('安全值');
    expect(r.displayText('仅自然语言，没有URL')).toBe('仅自然语言，没有URL');
    expect(r.usage({ inputTokens: 12, outputTokens: 8, pricingKnown: true, cost: 0 })).toEqual({ inputTokens: 12, outputTokens: 8, pricingKnown: true, cost: 0 });
  });
  it('URL 主机名规范化后也没有已知密钥，且不影响普通 URL', () => {
    const r = createEvidenceRedactor([], ['MiXeD-Fixture-Key']);
    const url = 'https://%4DiXeD-Fixture-Key.example.invalid/path';
    for (const cleaned of [r.url(url), r.displayText(`检查 ${url} 后继续`), r.displayText(JSON.stringify({ nested: { url } }))]) {
      expect(cleaned.toLowerCase()).not.toContain('mixed-fixture-key');
      expect(cleaned).not.toContain('%4D');
    }
    expect(r.displayText('检查 https://safe.example.invalid/path 后继续')).toBe('检查 https://safe.example.invalid/path 后继续');
  });
  it('残留I2 URL token内的JSON形状标点不能拆成脱敏范围外的片段', () => {
    const r = createEvidenceRedactor();
    const input = '请检查 https://example.invalid/reset?password=before{"safe":"AFTER_SECRET_918"}&mode=safe 然后继续';
    const clean = r.displayText(input);
    expect(clean).not.toContain('AFTER_SECRET_918');
    for (const safe of ['请检查', '/reset', 'mode=safe', '然后继续']) expect(clean).toContain(safe);
  });
  it('保留带尖括号的 Markdown 链接及标题', () => {
    const r = createEvidenceRedactor();
    expect(r.displayText('参见 [文档](<https://example.invalid/?token=hidden&mode=safe> "标题")')).toBe('参见 [文档](<https://example.invalid/?token=%5BREDACTED%5D&mode=safe> "标题")');
  });
  it.each(['before(inner)after', 'before)AFTER_SECRET_918', 'before%29AFTER_SECRET_918'])('Markdown 链接保留结束括号且不提前截断查询参数：%s', (query) => {
    const r = createEvidenceRedactor();
    const input = `参见 [文档](https://example.invalid/a(b)?token=${query}&mode=safe) 后继续`;
    expect(r.displayText(input)).toBe('参见 [文档](https://example.invalid/a(b)?token=%5BREDACTED%5D&mode=safe) 后继续');
  });
  it.each(['https://second.invalid/?password=SECOND_SECRET&mode=two', '<https://second.invalid/?password=SECOND_SECRET&mode=two>'])('分别脱敏无空格相邻的 Markdown 链接：%s', second => {
    const r = createEvidenceRedactor();
    const input = `参见 [一](https://first.invalid/a(b)?token=FIRST_SECRET&mode=one#anchor?x=1)[二](${second})`;
    const cleaned = `参见 [一](https://first.invalid/a(b)?token=%5BREDACTED%5D&mode=one#anchor?x=1)[二](${second.replace('SECOND_SECRET', '%5BREDACTED%5D')})`;
    expect(r.displayText(input)).not.toContain('SECOND_SECRET');
    expect(r.displayText(input)).toBe(cleaned);
  });
  it.each(['二[说明]', '二\\]说明[内[层]]'])('相邻 Markdown 链接分别脱敏，保留含嵌套或转义括号的标签：%s', label => {
    const r = createEvidenceRedactor();
    const input = `[一](https://first.invalid/?mode=one)[${label}](https://second.invalid/?password=SECOND_MARKER)`;
    expect(r.displayText(input)).toBe(input.replace('SECOND_MARKER', '%5BREDACTED%5D'));
  });
  it.each([['b', ''], ['b 有空格 ', ''], ['b', '图片说明'], ['b [嵌套', ']说明']])('相邻 Markdown 的后一标签含图片时分别脱敏且保留标签文本：%s / %s', (before, after) => {
    const r = createEvidenceRedactor();
    const input = `[a](https://first.invalid/?mode=one)[${before}![img](https://image.invalid/?x=1&password=TESTMARKER)${after}](https://second.invalid/?password=OTHER) 后继续`;
    expect(r.displayText(input)).toBe(input.replace('TESTMARKER', '%5BREDACTED%5D').replace('OTHER', '%5BREDACTED%5D'));
  });
  it('相邻 Markdown 图片的查询凭据不被前一链接的锚点吞掉', () => {
    const input = '[a](https://first.invalid/?mode=one#anchor?x=1)![img](https://image.invalid/?password=IMAGE_MARKER)';
    expect(createEvidenceRedactor().displayText(input)).toBe(input.replace('IMAGE_MARKER', '%5BREDACTED%5D'));
  });
  it('相邻 Markdown 图片的 IDN 主机仍命中已知密钥', () => {
    const r = createEvidenceRedactor([], ['ⓢëcret']);
    const first = '[a](https://first.invalid/?mode=one#anchor?x=1)';
    const input = `${first}![img](https://xn--prefixscret-5bb.invalid/)`;
    expect.soft(r.containsKnownSecret(input)).toBe(true);
    expect(r.displayText(input)).toBe(`${first}![img]([omitted: sensitive url host])`);
  });
  it('Markdown 标签内的 JSON 数组不切断相邻链接识别，并仍清理独立 JSON 头字段', () => {
    const markdown = '[a](https://first.invalid/?mode=one)[有 空格 ["甲"] ![img](https://image.invalid/?mode=two)](https://second.invalid/?password=OUTER_MARKER)';
    const headers = '{"headers":{"Authorization":"HEADER_MARKER","Cookie":["COOKIE_MARKER"],"Accept":"text/plain"}}';
    const r = createEvidenceRedactor();
    const expected = markdown.replace('OUTER_MARKER', '%5BREDACTED%5D');
    expect.soft(r.displayText(markdown)).toBe(expected);
    expect(r.displayText(`${markdown} 附加信息 ${headers}`)).toBe(`${expected} 附加信息 {"headers":{"Authorization":"[REDACTED]","Cookie":"[REDACTED]","Accept":"text/plain"}}`);
  });
  it.each([
    '<https://first.invalid/?token=FIRST_MARKER&mode=one#anchor?x=1>![图](https://second.invalid/?password=SECOND_MARKER)',
    '![图](https://first.invalid/?token=FIRST_MARKER&mode=one#anchor?x=1)<https://second.invalid/?password=SECOND_MARKER>',
    '<https://first.invalid/?token=FIRST_MARKER&mode=one#anchor?x=1><https://second.invalid/?password=SECOND_MARKER>',
  ])('无空格相邻的自动链接和图片保留各自边界：%s', input => {
    expect(createEvidenceRedactor().displayText(input)).toBe(input.replace('FIRST_MARKER', '%5BREDACTED%5D').replace('SECOND_MARKER', '%5BREDACTED%5D'));
  });
  it.each(['二 `[`', '二 `` ](` [ ``', '二 {"safe":"["}', '二 {"safe":"\\\"]"}'])('标签中的代码跨度或 JSON 字符串不参与 Markdown 括号配对：%s', label => {
    const input = `[一](https://first.invalid/?mode=one#anchor?x=1)[${label}](https://second.invalid/?password=SECOND_MARKER)`;
    expect(createEvidenceRedactor().displayText(input)).toBe(input.replace('SECOND_MARKER', '%5BREDACTED%5D'));
  });
  it('无法可靠拆开的 URL 不因位于代码跨度内而漏出后一查询的凭据', () => {
    const input = '`[甲](https://first.invalid/#anchor?x=1)[乙](https://second.invalid/?password=SECOND_MARKER)` 后续说明';
    const output = createEvidenceRedactor().displayText(input);
    expect(output).not.toContain('SECOND_MARKER');
    expect(output).toMatch(/^`.*` 后续说明$/);
  });
  it('URL 内的 JSON 字符串不能伪造相邻 Markdown 边界', () => {
    const input = '[一](https://first.invalid/?password={"safe":")[二](https://second.invalid/INNER_MARKER"}&mode=safe)';
    expect(createEvidenceRedactor().displayText(input)).toBe('[一](https://first.invalid/?password=%5BREDACTED%5D&mode=safe)');
  });
  it.each([
    '{"<https://first.invalid/?mode=one#anchor?x=1>!\\u005b图](https://xn--prefixscret-5bb.invalid/)":true}',
    '不完整标签 [<https://first.invalid/?mode=one#anchor?x=1>![[](https://xn--prefixscret-5bb.invalid/)',
    'https://first.invalid/?mode=one%29%21%5Bimg%5D%28https%3A%2F%2Fxn--prefixscret-5bb.invalid%2F%29',
    'https://first.invalid/#anchor?x=1%3E%3Chttps%3A%2F%2F%78%6E--prefixscret-5bb.invalid%2F%3E',
    '旧版记录仅留下主机：xn--prefixscret-5bb.invalid',
    'https://first.invalid/#anchor?x=1%253Chttps%253A%252F%252F%2578%256E--prefixscret-5bb.invalid%252F%253E',
    '{"https:\\/\\/\\u0078n--prefixscret-5bb.invalid\\/":true}',
  ])('历史 IDN 屏障不依赖 Markdown 识别或 URL 展示：%s', input => {
    const r = createEvidenceRedactor([], ['ⓢëcret']);
    expect(r.containsKnownSecret(input)).toBe(true);
    expect(r.containsKnownSecret(input.replace(/prefixscret-5bb/g, 'bcher-kva'))).toBe(false);
  });
  it('展示 JSON 键和 URL 内未能单独分词的 IDN 也不会漏出', () => {
    const r = createEvidenceRedactor([], ['ⓢëcret']);
    const host = 'xn--prefixscret-5bb.invalid';
    expect(r.displayText(JSON.stringify({ [`<https://${host}/>`]: true, safe: 1 }))).not.toContain(host);
    expect(r.displayText(`https://first.invalid/#anchor?x=1%3E%3Chttps%3A%2F%2F${host}%2F%3E`)).not.toContain(host);
    expect(r.displayText('普通 HTTPS https://first.invalid/#anchor?x=1')).toBe('普通 HTTPS https://first.invalid/#anchor?x=1');
  });
  it('多个敏感键变成同一占位符时保留各字段与原有安全键', () => {
    const r = createEvidenceRedactor([], ['ⓢëcret']);
    const placeholder = '[omitted: sensitive url host]';
    const input = {
      'https://xn--prefixscret-5bb.invalid/a': 1,
      'https://xn--prefixscret-5bb.invalid/b': 2,
      [placeholder]: 3,
      [`${placeholder} #2`]: 4,
    };
    const raw = JSON.stringify(input);
    const expected = { [`${placeholder} #3`]: 1, [`${placeholder} #4`]: 2, [placeholder]: 3, [`${placeholder} #2`]: 4 };
    expect.soft(r.value(input)).toEqual(expected);
    expect.soft(JSON.parse(r.displayText(raw))).toEqual(expected);
    expect(JSON.parse(r.body(raw, 'application/json'))).toEqual(expected);
  });
  it('原始 JSON 中重复的同一个键仍按最后一个值解释', () => {
    const r = createEvidenceRedactor();
    const input = '{"id":1,"id":2}';
    expect(JSON.parse(r.displayText(input))).toEqual({ id: 2 });
    expect(JSON.parse(r.body(input, 'application/json'))).toEqual({ id: 2 });
  });
  it('Unicode 兼容字符折叠后仍能脱敏并阻断规范化历史', () => {
    const r = createEvidenceRedactor([], ['ⓢëcret']);
    const url = 'https://prefixⓢëcret.invalid/';
    const normalized = 'https://xn--prefixscret-5bb.invalid/';
    expect(r.url(url)).toBe('[omitted: sensitive url host]');
    expect(r.displayText(`检查 ${normalized} 后继续`)).toBe('检查 [omitted: sensitive url host] 后继续');
    expect(r.containsKnownSecret(`检查 ${normalized} 后继续`)).toBe(true);
  });
  it('不把带分隔符或无法转换的密钥误识别为普通主机名', () => {
    const r = createEvidenceRedactor([], ['ⓢëcret/other', 'ⓢëcret?other', 'ⓢëcret%2e', '­.­', 'a‍b', '\ud800', '２１３０７０６４３３']);
    const url = 'https://prefixsëcret.invalid/';
    expect(r.url(url)).toBe(new URL(url).href);
    expect(r.containsKnownSecret(url)).toBe(false);
    expect(r.containsKnownSecret('https://ab.invalid/')).toBe(false);
    expect(r.containsKnownSecret('https://127.0.0.1/')).toBe(false);
    expect(r.containsKnownSecret('https://prefixsëcret.invalid./')).toBe(false);
    expect(r.containsKnownSecret('正文 ⓢëcret/other')).toBe(true);
    expect(r.displayText('检查 https://[broken 后继续')).toBe('检查 [omitted: ambiguous url] 后继续');
    expect(r.containsKnownSecret('检查 https://[broken 后继续')).toBe(false);
  });
  it.each(['。', '．', '｡'])('按 IDN 规则折叠密钥里的域名分隔符：%s', dot => {
    const r = createEvidenceRedactor([], [`sëcret${dot}example`]);
    const url = `https://prefixsëcret${dot}example.invalid/`;
    expect(r.url(url)).toBe('[omitted: sensitive url host]');
    expect(r.displayText(`检查 ${new URL(url).href} 后继续`)).toBe('检查 [omitted: sensitive url host] 后继续');
  });
  it('保留名为 cookie 的画像角色对象，仍遮蔽字符串和字符串数组凭据', () => {
    const r = createEvidenceRedactor([], ['fixture-secret']);
    const input = { version: 1, actors: { cookie: { kind: 'anonymous' } }, headers: { Cookie: 'unlisted-cookie', 'Set-Cookie': ['unlisted-1', 'unlisted-2'], Authorization: 'unlisted-auth' }, note: 'fixture-secret' };
    const expected = { ...input, headers: { Cookie: '[REDACTED]', 'Set-Cookie': '[REDACTED]', Authorization: '[REDACTED]' }, note: '[REDACTED]' };
    expect(r.value(input)).toEqual(expected);
    expect(JSON.parse(r.displayText(JSON.stringify(input)))).toEqual(expected);
  });
  it('明确的 headers 内遮蔽混合数组凭据，但保留画像 cookie 对象', () => {
    const r = createEvidenceRedactor();
    const input = {
      actors: { cookie: { kind: 'anonymous' } },
      nested: { headers: { ' Proxy_Authorization ': [null, 'AUTH_MARKER', { opaque: 'NESTED_MARKER' }], Cookie: ['COOKIE_MARKER', 1], Accept: ['text/plain', 1] } },
    };
    const expected = { ...input, nested: { headers: { ' Proxy_Authorization ': '[REDACTED]', Cookie: '[REDACTED]', Accept: ['text/plain', 1] } } };
    expect.soft(r.value(input)).toEqual(expected);
    expect.soft(JSON.parse(r.displayText(JSON.stringify(input)))).toEqual(expected);
    expect(JSON.parse(r.body(JSON.stringify(input), 'application/json'))).toEqual(expected);
  });
  it('字符串化 JSON 外围的 Unicode 空白不妨碍字段脱敏', () => {
    const r = createEvidenceRedactor();
    const input = String.fromCodePoint(0xa0) + '{"password":"PASSWORD_MARKER","id":9223372036854775807}' + String.fromCodePoint(0xfeff);
    expect(r.value(input)).toBe('{"password":"[REDACTED]","id":9223372036854775807}');
  });
  it('含已知秘密的数字 token 用有效 JSON 遮蔽，而不是保留明文', () => {
    const r = createEvidenceRedactor([], ['7891234567']);
    expect(r.displayText('{"id":978912345678,"safe":9223372036854775807}')).toBe('{"id":"[REDACTED]","safe":9223372036854775807}');
  });
  it('脱敏时按原 token 保留独立、内嵌和字符串化 JSON 的非敏感数字', () => {
    const nested = '{"id":-9007199254740995,"token":"TOKEN_MARKER"}';
    const input = `{"id":9223372036854775807,"exp":1e400,"decimal":0.10000000000000000001,"nested":${JSON.stringify(nested)},"password":12345678901234567890}`;
    const expected = input.replace('TOKEN_MARKER', '[REDACTED]').replace('12345678901234567890', '"[REDACTED]"');
    const r = createEvidenceRedactor();
    expect.soft(r.displayText(input)).toBe(expected);
    expect.soft(r.displayText(`运行信息 ${input} 已保留`)).toBe(`运行信息 ${expected} 已保留`);
    expect.soft(r.value(input)).toBe(expected);
    expect(r.body(input, 'application/json')).toBe(expected);
  });
  it('Markdown URL 的内层括号中出现近似链接边界时不截断敏感值', () => {
    const r = createEvidenceRedactor();
    const input = '[一](https://first.invalid/?token=(a)[二](https://second.invalid/INNER_SECRET)&mode=safe)';
    // 查询值可含括号及 URL；只有真正的外层链接结束符才能分隔两个链接。
    expect(r.displayText(input)).toBe('[一](https://first.invalid/?token=%5BREDACTED%5D&mode=safe)');
  });
  it('大量未闭合括号不会反复扫描尾部，仍可清理末尾完整 JSON', () => {
    const r = createEvidenceRedactor();
    const prefix = '['.repeat(50_000);
    const start = performance.now();
    const result = r.displayText(`${prefix} 注记 {"token":"unknown-test-value","mode":"safe"}`);
    expect(performance.now() - start).toBeLessThan(1_500);
    expect(result).toBe(`${prefix} 注记 {"token":"[REDACTED]","mode":"safe"}`);
  }, 30_000);
  it('损坏外层字符串不妨碍清理其内部的完整 JSON 对象', () => {
    const r = createEvidenceRedactor();
    const input = '异常 {"text":"包裹不完整 {"token":"unknown-inner-value","safe":"保留"}';
    expect(r.displayText(input)).toBe('异常 {"text":"包裹不完整 {"token":"[REDACTED]","safe":"保留"}');
  });
  it('遮蔽敏感 DOM 和不可验证区域', () => {
    const r = createEvidenceRedactor([], [secret]);
    const dom = sanitizeDom([{ tag: 'input', type: 'password', value: 'unknown' }, { tag: 'div', text: secret }, { tag: 'iframe', text: 'unseen' }, { tag: 'span', text: 'safe' }], r);
    expect(JSON.stringify(dom)).not.toMatch(/unknown|sentinel|unseen/);
    expect(JSON.stringify(dom)).toContain('safe');
  });
  it('先保存内容后索引并核验归属、摘要和缺失，完整目录不含哨兵', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'evidence-'));
    try {
      const artifacts = new ArtifactStore(root);
      const store = new EvidenceStore(artifacts, ctx, createEvidenceRedactor([], [secret]));
      const record = await store.saveText('console', `error ${secret}`, meta);
      expect((await store.verify(record)).toString()).not.toContain(secret);
      await expect(store.verify({ ...record, caseId: 'M-TC-2' })).rejects.toThrow();
      await expect(store.verify({ ...record, redacted: false })).rejects.toThrow();
      await expect(store.verify({ ...record, id: 'e-fake' })).rejects.toThrow();
      const trace = store.sanitizeTrace({ ...ctx, actionId: 'a-1', phase: 'execution', time: '2026-11-13T00:00:00Z', event: 'error', message: `failed ${secret}`, action: { type: 'fill', locator: null, input: { kind: 'secretRef', env: 'PASSWORD_ENV' } }, beforeEvidenceIds: [], afterEvidenceIds: [], result: { status: 'error', output: { message: secret }, error: secret }, durationMs: 1 });
      expect(JSON.stringify(trace)).not.toContain(secret);
      expect(trace.action.input).toEqual({ kind: 'secretRef', env: 'PASSWORD_ENV' });
      await store.saveHar({ log: { version: '1.2', creator: { name: 'fixture', version: '1' }, entries: [{ startedDateTime: '2026-11-13T00:00:00Z', time: 42, request: { method: 'POST', url: `/x?session=${secret}`, headers: [{ name: 'Authorization', value: secret }], cookies: [{ name: 'sid', value: secret }], queryString: [{ name: 'sid', value: secret }], postData: { mimeType: 'application/json', text: '{"password":"oops"' } }, response: { status: 302, redirectURL: `/x?token=${secret}`, headers: [{ name: 'Location', value: `/x?token=${secret}` }], cookies: [{ name: 'x', value: secret }], content: { mimeType: 'application/json', encoding: 'base64', text: Buffer.from(JSON.stringify({ password: secret, value: 1 })).toString('base64'), size: 25 } } }] } }, meta);
      const binary = JSON.stringify(sanitizeHar({ log: { entries: [{ response: { content: { mimeType: 'application/octet-stream', text: Buffer.from(secret).toString('base64'), encoding: 'base64' } } }] } }, createEvidenceRedactor([], [secret])));
      expect(binary).toContain('omitted');
      expect(binary).not.toContain(secret);
      expect(createEvidenceRedactor([], [secret]).usage({ inputTokens: 12, outputTokens: 8, pricingKnown: true, cost: 0 })).toEqual({ inputTokens: 12, outputTokens: 8, pricingKnown: true, cost: 0 });
      await store.saveDom([{ tag: 'input', type: 'password', value: secret }], meta);
      await expect(store.verify({ ...record, digest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow();
      await expect(store.saveScreenshot(Buffer.from(secret), meta)).rejects.toThrow();
      const walk = async (dir: string): Promise<string> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async e => e.isDirectory() ? walk(path.join(dir, e.name)) : (await readFile(path.join(dir, e.name))).toString()))).join('\n');
      expect(await walk(path.join(root, '.crosscheck'))).not.toContain(secret);
      await artifacts.remove(record.path);
      await expect(store.verify(record)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
