import { describe, expect, it } from 'vitest';
import { createRedactor, REDACTED } from '../src/index';

describe('证据脱敏边界', () => {
  it('处理相对地址、SPA hash 和 session 字段', () => {
    const r = createRedactor();
    expect(r.url('/app?session=abc#/route?sid=xyz&ok=1')).not.toMatch(/abc|xyz/);
    expect(r.value({ sessionId: 'xyz', sid: 'abc' })).toEqual({ sessionId: REDACTED, sid: REDACTED });
  });
  it('省略无法安全解析的 multipart', () => {
    expect(createRedactor().text('password=abc', 'multipart/form-data')).not.toContain('abc');
  });
});
