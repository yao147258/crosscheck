import { describe, expect, it } from 'vitest';
import { createRedactor, REDACTED } from '../src/index';

const r = createRedactor(['idCard']);

describe('Redactor', () => {
  it('敏感请求头不区分大小写', () => {
    expect(r.headers({ Authorization: 'Bearer x', 'set-cookie': ['a=1', 'b=2'], Accept: '*/*' })).toEqual({
      Authorization: REDACTED,
      'set-cookie': [REDACTED, REDACTED],
      Accept: '*/*',
    });
  });

  it('深层对象中的密码与登记字段', () => {
    const input = { user: { name: 'a', password: 'p', IDCARD: '110' }, list: [{ newPassword: 'q' }] };
    expect(r.value(input)).toEqual({ user: { name: 'a', password: REDACTED, IDCARD: REDACTED }, list: [{ newPassword: REDACTED }] });
    expect(input.user.password).toBe('p'); // 不修改原对象
  });

  it('JSON 文本', () => {
    expect(JSON.parse(r.text('{"password":"p","a":1}', 'application/json; charset=utf-8'))).toEqual({ password: REDACTED, a: 1 });
  });

  it('表单文本', () => {
    expect(r.text('user=a&password=p', 'application/x-www-form-urlencoded')).toBe(`user=a&password=${encodeURIComponent(REDACTED)}`);
  });

  it('其他文本原样返回，非法 JSON 不抛错', () => {
    expect(r.text('hello', 'text/plain')).toBe('hello');
    expect(r.text('{bad', 'application/json')).toBe('{bad');
  });

  it('URL 查询参数', () => {
    expect(r.url('http://h/x?token=1&password=2&idcard=3')).toBe(
      `http://h/x?token=1&password=${encodeURIComponent(REDACTED)}&idcard=${encodeURIComponent(REDACTED)}`,
    );
  });
});
