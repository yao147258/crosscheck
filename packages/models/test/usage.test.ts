import { describe, expect, it } from 'vitest';
import { UsageMeter } from '../src/index';

describe('UsageMeter', () => {
  it('按角色累计 token 与费用', () => {
    const m = new UsageMeter({ 'openai:gpt-5.4': { inputPerMTok: 2, outputPerMTok: 8 } });
    m.add('executor', 'openai:gpt-5.4', { inputTokens: 1_000_000, outputTokens: 500_000 });
    m.add('reviewer', 'qwen:qwen-max', { inputTokens: 10, outputTokens: undefined });
    const t = m.totals();
    expect(t.byRole.executor).toEqual({ inputTokens: 1_000_000, outputTokens: 500_000, cost: 6 });
    expect(t.byRole.reviewer).toEqual({ inputTokens: 10, outputTokens: 0, cost: 0 });
    expect(t).toMatchObject({ inputTokens: 1_000_010, outputTokens: 500_000, cost: 6 });
  });
});
