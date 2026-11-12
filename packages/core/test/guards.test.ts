import { describe, expect, it } from 'vitest';
import { checkReadonlySql, checkRequest, type Guardrails } from '../src/index';

const g: Guardrails = {
  allowedHosts: ['localhost:3000', '127.0.0.1', '*.staging.example.com'],
  forbidden: [
    { method: 'DELETE', path: '/api/**' },
    { path: '/admin/danger/*' },
  ],
  redactFields: [],
};

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
});

describe('checkReadonlySql', () => {
  it.each([
    'SELECT * FROM users WHERE id = 1',
    'select count(*) from orders;',
    'WITH t AS (SELECT 1 AS x) SELECT x FROM t',
    "SELECT * FROM logs WHERE msg = 'please DELETE me; now'",
    'SELECT replace(name, \'a\', \'b\') FROM t -- trailing comment with UPDATE',
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
});
