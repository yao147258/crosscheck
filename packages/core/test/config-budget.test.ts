import { describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from '../src/index';

describe('扫描预算配置', () => {
  it('缺省时使用扫描默认值，且不影响单用例预算', () => {
    expect(ProjectConfigSchema.parse({}).budget).toEqual({
      perCase: { steps: 60, tokens: 400000, minutes: 10 },
      discovery: { steps: 80, tokens: 600000, minutes: 15 },
    });
  });
  it('显式配置时按字段覆盖', () => {
    expect(ProjectConfigSchema.parse({ budget: { discovery: { steps: 5 } } }).budget.discovery).toEqual({ steps: 5, tokens: 600000, minutes: 15 });
  });
});
