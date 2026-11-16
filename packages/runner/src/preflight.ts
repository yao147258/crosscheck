import type { TestCase, VerifiedRunInputs } from '@crosscheck/core';

/** 只看批准后的结构化字段；自然语言页面步骤不构成浏览器准入判据。 */
export function preflight(input: VerifiedRunInputs, tc: TestCase): string | undefined {
  const actor = input.profile['auth.yaml'].actors[tc.actor]!;
  if (tc.expectations.some(e => e.evidence.some(type => type === 'screenshot' || type === 'dom')) || actor.kind === 'form' || actor.kind === 'replay' || actor.kind === 'token' && actor.inject.kind === 'storage') return '浏览器工具暂缓，计划 2 不支持';
  return input.selection.blocked.find(item => item.id === tc.id)?.reason;
}
