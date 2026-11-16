import { describe, expect, it } from 'vitest';
import { hostPortAllowed, checkReadonlySql, checkRequest, type Guardrails } from '../src/index';

const g: Guardrails = {
  allowedHosts: ['localhost:3000', '127.0.0.1', '*.staging.example.com'],
  forbidden: [
    { method: 'DELETE', path: '/api/**' },
    { path: '/admin/danger/*' },
  ],
  redactFields: [],
};

describe('hostPortAllowed', () => {
  it.each([
    ['127.0.0.1', '8001', ['127.0.0.1:8000'], false],
    ['EXAMPLE.test', '443', ['example.test'], true],
    ['x.example.test', '443', ['*.example.test'], true],
    ['example.test', '443', ['*.example.test'], false],
    ['[::1]', '1234', ['[0:0:0:0:0:0:0:1]:1234'], true],
    ['example.test', null, ['example.test:443'], false],
    ['example.test', null, ['example.test'], true],
    ['example.test', '443', ['example.test:443/path'], false],
  ] as const)('%s:%s 的匹配结果为 %s', (host, port, entries, expected) => {
    expect(hostPortAllowed(host, port, [...entries])).toBe(expected);
  });
});

describe('checkRequest', () => {
  it.each([
    ['http://localhost:3000/api/x', true],
    ['http://localhost:4000/api/x', false],
    ['http://127.0.0.1:8080/', true],
    ['https://a.staging.example.com/', true],
    ['https://staging.example.com/', false],
    ['https://evil.com/', false],
    ['file:///etc/passwd', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => {
    expect(checkRequest({ url }, g).ok).toBe(ok);
  });

  it('禁止的方法和路径', () => {
    expect(checkRequest({ url: 'http://localhost:3000/api/orders/1', method: 'delete' }, g).ok).toBe(false);
    expect(checkRequest({ url: 'http://localhost:3000/api/orders/1', method: 'GET' }, g).ok).toBe(true);
  });

  it('未写方法的禁止规则匹配任意方法，* 只匹配单段', () => {
    expect(checkRequest({ url: 'http://localhost:3000/admin/danger/wipe' }, g).ok).toBe(false);
    expect(checkRequest({ url: 'http://localhost:3000/admin/danger/a/b' }, g).ok).toBe(true);
  });

  it('拒绝原因可读', () => {
    expect(checkRequest({ url: 'https://evil.com/' }, g)).toEqual({ ok: false, reason: '主机不在白名单内：evil.com' });
  });

  it.each([
    ['http://localhost:3000/admin/danger/wipe/', 'method', undefined],
    ['http://localhost:3000/admin/%64anger/wipe', 'method', undefined],
    ['http://localhost:3000/%61pi/orders/1', 'method', 'DELETE'],
    ['http://localhost:3000/api%2Forders', 'method', 'DELETE'],
    ['http://localhost:3000/API/orders/1', 'method', 'DELETE'],
    ['http://localhost:3000/admin//danger/wipe', 'method', undefined],
    ['http://localhost:3000/admin;x/danger/wipe', 'method', undefined],
    ['http://localhost:3000/api', 'method', 'DELETE'],
  ])('绕过尝试必须被拒绝：%s (%s)', (url, _label, method) => {
    expect(checkRequest({ url, method: method as string | undefined }, g).ok).toBe(false);
  });

  it('IPv6 白名单条目带端口可以可靠匹配', () => {
    const g6: Guardrails = {
      allowedHosts: ['[::1]:3000'],
      forbidden: [],
      redactFields: [],
    };
    expect(checkRequest({ url: 'http://[::1]:3000/' }, g6).ok).toBe(true);
    expect(checkRequest({ url: 'http://[::1]:4000/' }, g6).ok).toBe(false);
  });

  it('method 带前后空白仍能命中禁止规则', () => {
    expect(checkRequest({ url: 'http://localhost:3000/api/orders/1', method: ' delete ' }, g).ok).toBe(false);
  });

  it('N4 矩阵参数伪装的 .. 段必须被拒绝（原始 .. 已被 URL 解析器自身折叠，不在此列）', () => {
    expect(checkRequest({ url: 'http://localhost:3000/foo/..;/admin/x' }, g).ok).toBe(false);
  });

  it('N6 条目写明端口（含默认端口 80/443）必须严格比较', () => {
    const gPort: Guardrails = {
      allowedHosts: ['127.0.0.1:80', 'secure.example.com:443'],
      forbidden: [],
      redactFields: [],
    };
    expect(checkRequest({ url: 'http://127.0.0.1/' }, gPort).ok).toBe(true);
    expect(checkRequest({ url: 'http://127.0.0.1:80/' }, gPort).ok).toBe(true);
    expect(checkRequest({ url: 'http://127.0.0.1:5432/' }, gPort).ok).toBe(false);
    expect(checkRequest({ url: 'https://secure.example.com/' }, gPort).ok).toBe(true);
    expect(checkRequest({ url: 'https://secure.example.com:8443/' }, gPort).ok).toBe(false);
  });

  it('N7 /** 前缀分支必须正确转义，不抛异常也不误判', () => {
    const g7: Guardrails = {
      allowedHosts: ['localhost:3000'],
      forbidden: [{ path: '/**/x/**' }, { path: '/admin/*/**' }],
      redactFields: [],
    };
    expect(() => checkRequest({ url: 'http://localhost:3000/a/x/b' }, g7)).not.toThrow();
    expect(checkRequest({ url: 'http://localhost:3000/admin' }, g7).ok).toBe(true);
    expect(checkRequest({ url: 'http://localhost:3000/admin/a/b' }, g7).ok).toBe(false);
  });

  it('N8 规则路径自身的尾斜杠也要规范化', () => {
    const g8: Guardrails = {
      allowedHosts: ['localhost:3000'],
      forbidden: [{ path: '/api/' }],
      redactFields: [],
    };
    expect(checkRequest({ url: 'http://localhost:3000/api' }, g8).ok).toBe(false);
  });

  it('N8(第 3 轮) 规则路径的 // 也要合并后再匹配', () => {
    const g8b: Guardrails = {
      allowedHosts: ['localhost:3000'],
      forbidden: [{ path: '/a//b' }],
      redactFields: [],
    };
    expect(checkRequest({ url: 'http://localhost:3000/a/b' }, g8b).ok).toBe(false);
  });

  it('B2 带路径的白名单条目格式非法，视为不匹配任何请求', () => {
    const gBad: Guardrails = {
      allowedHosts: ['localhost:3000/'],
      forbidden: [],
      redactFields: [],
    };
    expect(checkRequest({ url: 'http://localhost:3000/' }, gBad).ok).toBe(false);
    expect(checkRequest({ url: 'http://localhost:5432/' }, gBad).ok).toBe(false);
  });

  it('B2 带路径的白名单条目（带子路径）同样格式非法', () => {
    const gBad2: Guardrails = {
      allowedHosts: ['localhost:3000/x'],
      forbidden: [],
      redactFields: [],
    };
    expect(checkRequest({ url: 'http://localhost:3000/' }, gBad2).ok).toBe(false);
    expect(checkRequest({ url: 'http://localhost:5432/' }, gBad2).ok).toBe(false);
  });

  it.each(['*.ex.com:8080', 'a@host', 'host#x', 'host\\x', 'host?x', '*.[::1]', '*.*.ex.com'])(
    '第 4 轮 不合法的白名单条目 %s 不放行任何请求',
    (entry) => {
      const gBad: Guardrails = { allowedHosts: [entry], forbidden: [], redactFields: [] };
      for (const url of [
        'http://a.ex.com:8080/',
        'http://a.ex.com/',
        'http://host/',
        'http://a@host/',
        'http://[::1]/',
        'http://a.b.ex.com/',
      ]) {
        expect(checkRequest({ url }, gBad).ok).toBe(false);
      }
    },
  );

  it('第 4 轮 合法白名单条目格式仍然生效', () => {
    const gOk: Guardrails = {
      allowedHosts: ['*.staging.example.com', '[::1]:3000', '127.0.0.1', 'Example.COM:8080'],
      forbidden: [],
      redactFields: [],
    };
    expect(checkRequest({ url: 'https://a.staging.example.com/' }, gOk).ok).toBe(true);
    expect(checkRequest({ url: 'http://[::1]:3000/' }, gOk).ok).toBe(true);
    expect(checkRequest({ url: 'http://127.0.0.1:9999/' }, gOk).ok).toBe(true);
    expect(checkRequest({ url: 'http://example.com:8080/' }, gOk).ok).toBe(true);
    expect(checkRequest({ url: 'http://example.com:8081/' }, gOk).ok).toBe(false);
  });

  it('B2 既有的通配符白名单条目仍能正常通过', () => {
    expect(checkRequest({ url: 'https://a.staging.example.com/' }, g).ok).toBe(true);
    expect(checkRequest({ url: 'http://localhost:3000/api/x' }, g).ok).toBe(true);
  });
});

describe('checkReadonlySql', () => {
  it.each([
    'SELECT * FROM users WHERE id = 1',
    'select count(*) from orders;',
    'WITH t AS (SELECT 1 AS x) SELECT x FROM t',
    "SELECT * FROM logs WHERE msg = 'please DELETE me; now'",
    "SELECT '--'",
    "SELECT '/* x */'",
    'SELECT "a--b" FROM t',
  ])('允许：%s', (sql) => {
    expect(checkReadonlySql(sql)).toEqual({ ok: true });
  });

  it.each([
    'DELETE FROM users',
    'UPDATE users SET a = 1',
    'INSERT INTO t VALUES (1)',
    'DROP TABLE t',
    'SELECT 1; DROP TABLE t',
    'SELECT * INTO backup FROM users',
    'SELECT * FROM t FOR UPDATE',
    'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
    'SELECT pg_sleep(10)',
    'TRUNCATE t',
    'SELECT $$x$$',
    '',
    "SELECT '--'; COMMIT; DROP TABLE t",
    "SELECT '/*'; DELETE FROM t; SELECT '*/'",
    "SELECT E'a\\''; DROP TABLE t; SELECT ''",
    'SELECT 1 #\'\n; DROP TABLE t #\'',
    "SELECT * FROM t /*! INTO OUTFILE '/tmp/x' */",
    'SELECT "pg_terminate_backend"(pid) FROM pg_stat_activity',
    'SELECT "pg_sleep"(10)',
    "SELECT \"set_config\"('a','b',false)",
    // 第 3 轮：从允许列表移入——控制者裁定不再支持按方言区分的注释豁免，
    // 只读查询中一律不允许出现 --/*/*/（字符串/标识符内部除外），这里的 -- 在字符串外，必须拒绝
    'SELECT replace(name, \'a\', \'b\') FROM t -- trailing comment with UPDATE',
  ])('拒绝：%s', (sql) => {
    expect(checkReadonlySql(sql).ok).toBe(false);
  });

  it.each([
    "SELECT /* /* */ ' */ ; DROP TABLE t; -- '",
    "SELECT /* /* */ ' */ * INTO newt FROM users -- '",
    'SELECT 1 --x\r; DROP TABLE t',
    'SELECT * --\rINTO newt FROM users',
    "SELECT $é$'$é$; DROP TABLE t; SELECT $é$'$é$",
    'SELECT U&"pg!0073leep" UESCAPE \'!\'(10)',
    'SELECT 1 --1; DROP TABLE t',
  ])('N1/N2/N3/N5/N8 绕过必须被拒绝：%s', (sql) => {
    expect(checkReadonlySql(sql).ok).toBe(false);
  });

  it.each([
    "SELECT /* /*/ ' */ */ ; DROP TABLE t; -- '",
    "SELECT /* /*/ ' */ */ * INTO newt FROM users -- '",
    "SELECT * FROM users -- \r'\nINTO OUTFILE '/tmp/x' -- '",
    "SELECT 1 -- \r'\n; DROP TABLE t; -- '",
    "SELECT * FROM t /*M! INTO OUTFILE '/tmp/x' */",
  ])('第 3 轮 N1/B1 绕过必须被拒绝：%s', (sql) => {
    expect(checkReadonlySql(sql).ok).toBe(false);
  });

  it.each([
    "WITH x([a']) AS (SELECT 1) DELETE FROM t WHERE 1 IN (SELECT [a'] FROM x)",
    "SELECT 1 AS [a'];DROP TABLE t;SELECT 1 AS [']",
    "SELECT load_extension('x')",
  ])('第 4 轮 S1 SQLite 方括号标识符 / load_extension 必须被拒绝：%s', (sql) => {
    expect(checkReadonlySql(sql).ok).toBe(false);
  });

  it('第 4 轮 S1 方括号的拒绝原因可读', () => {
    expect(checkReadonlySql('SELECT [a] FROM t')).toEqual({
      ok: false,
      reason: '不允许在字符串/引号标识符之外使用方括号（[ 或 ]）',
    });
  });

  it.each(["SELECT '[a]'", 'SELECT "[a]" FROM t'])('第 4 轮 字符串/引号标识符内的方括号仍允许：%s', (sql) => {
    expect(checkReadonlySql(sql)).toEqual({ ok: true });
  });
});
