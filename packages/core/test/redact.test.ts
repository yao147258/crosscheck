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

  it('请求头名两端空白被忽略', () => {
    expect(r.headers({ ' Authorization ': 'Bearer x', '  Cookie  ': 'session=abc' })).toEqual({
      ' Authorization ': REDACTED,
      '  Cookie  ': REDACTED,
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
    // 按裁定：token 被纳入敏感字段，应脱敏
    expect(r.url('http://h/x?token=1&password=2&idcard=3')).toBe(
      `http://h/x?token=${encodeURIComponent(REDACTED)}&password=${encodeURIComponent(REDACTED)}&idcard=${encodeURIComponent(REDACTED)}`,
    );
  });

  it('URL 中用户名密码被脱敏', () => {
    expect(r.url('http://user:secret@host/path?x=1')).toBe(`http://${encodeURIComponent(REDACTED)}:${encodeURIComponent(REDACTED)}@host/path?x=1`);
  });

  it('URL hash 中的 token 被脱敏', () => {
    expect(r.url('http://h/x#access_token=abc&state=1')).toBe(`http://h/x#access_token=${encodeURIComponent(REDACTED)}&state=1`);
  });

  it('URL hash 中的敏感字段被脱敏', () => {
    expect(r.url('http://h/x#id_token=xyz&refresh_token=abc')).toBe(
      `http://h/x#id_token=${encodeURIComponent(REDACTED)}&refresh_token=${encodeURIComponent(REDACTED)}`,
    );
  });

  it('字符串化的 JSON 需要递归脱敏', () => {
    const input = { webhookPayload: JSON.stringify({ password: 'p', nested: { api_key: 'secret' } }) };
    const result = r.value(input);
    expect(JSON.parse(result.webhookPayload as string)).toEqual({
      password: REDACTED,
      nested: { api_key: REDACTED },
    });
  });

  it('敏感请求头名带空白被脱敏', () => {
    expect(r.headers({ ' token ': 'abc' })).toEqual({
      ' token ': REDACTED,
    });
  });

  it('自定义敏感字段名带空白被脱敏', () => {
    expect(r.headers({ ' idCard ': '110' })).toEqual({
      ' idCard ': REDACTED,
    });
  });

  it('对象字段名带空白被脱敏', () => {
    expect(r.value({ ' secret ': 's' })).toEqual({
      ' secret ': REDACTED,
    });
  });
});
