import { describe, it, expect } from 'vitest';
import { GuardrailsSchema } from '../../core/src/index';
import { RequestPolicy } from '../src/network/policy';

const guardrails = GuardrailsSchema.parse({ allowedHosts: ['localhost'], forbidden: [{ method: 'GET', path: '/private' }] });

describe('统一请求策略', () => {
  it('加载时拒绝无效主机条目', () => {
    expect(GuardrailsSchema.safeParse({ allowedHosts: ['localhost/path'] }).success).toBe(false);
  });
  it('拒绝 HEAD 绕过 GET 禁令及 userinfo', () => {
    const policy = new RequestPolicy(guardrails);
    expect(policy.check({ url: 'http://localhost/private', method: 'HEAD' }).ok).toBe(false);
    expect(policy.check({ url: 'http://user:pass@localhost/', method: 'GET' }).ok).toBe(false);
  });
  it('拒绝方法覆盖与无法验证的正文', () => {
    const policy = new RequestPolicy(guardrails);
    for (const input of [
      { url: 'http://localhost/?_method=DELETE' },
      { url: 'http://localhost/', headers: [['X-Method-Override', 'DELETE']] as [string, string][] },
      { url: 'http://localhost/', headers: [['Content-Type', 'application/json']] as [string, string][], body: '{"_method":"DELETE"}' },
      { url: 'http://localhost/', body: 'opaque' },
    ]) expect(policy.check(input).ok).toBe(false);
  });
});
