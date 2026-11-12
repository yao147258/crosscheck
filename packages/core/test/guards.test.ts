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
  ])('拒绝：%s', (sql) => {
    expect(checkReadonlySql(sql).ok).toBe(false);
  });
});
