import { describe, expect, it } from 'vitest';
import { checkReadonlySql } from '../src/guard/sql-guard';

describe('显式 PostgreSQL 参数模式', () => {
  it('有序参数只按占位符绑定，不改变默认拒绝规则', () => {
    expect(checkReadonlySql('SELECT $1::text, $2::int, $1', { parameterCount: 2 })).toEqual({ ok: true });
    expect(checkReadonlySql('SELECT $1').ok).toBe(false);
  });
  it('字符串与标识符中的美元符不算占位符', () => {
    expect(checkReadonlySql("SELECT '$9', \"$8\", $1", { parameterCount: 1 })).toEqual({ ok: true });
    expect(checkReadonlySql("SELECT '$1'", { parameterCount: 1 }).ok).toBe(false);
  });
  it.each(['SELECT $0', 'SELECT $2', 'SELECT $1, $3', 'SELECT $01', 'SELECT $1x', 'SELECT foo$1', 'SELECT $$x$$', 'SELECT $tag$x$tag$', 'SELECT $1$2', 'SELECT $1; DELETE FROM t', 'SELECT $1 -- x'])('拒绝歧义和越界：%s', sql => {
    expect(checkReadonlySql(sql, { parameterCount: 2 }).ok).toBe(false);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('拒绝非法参数计数 %s', parameterCount => {
    expect(checkReadonlySql('SELECT 1', { parameterCount }).ok).toBe(false);
  });
  it('零参数和重复引用合法，不接受缺失的声明', () => {
    expect(checkReadonlySql('SELECT 1', { parameterCount: 0 }).ok).toBe(true);
    expect(checkReadonlySql('SELECT $1, $1', { parameterCount: 1 }).ok).toBe(true);
    expect(checkReadonlySql('SELECT $1', { parameterCount: 2 }).ok).toBe(false);
  });
});
