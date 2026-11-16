import type { TestCase, VerifiedRunInputs } from '@crosscheck/core';

/** 只看批准后的结构化字段；自然语言页面步骤不构成浏览器准入判据。 */
export function preflight(input: VerifiedRunInputs, tc: TestCase): string | undefined {
  const blocked = input.selection.blocked.find(item => item.id === tc.id)?.reason;
  if (blocked) return blocked;
  const actor = input.profile['auth.yaml'].actors[tc.actor];
  if ((actor?.kind === 'form' || actor?.kind === 'replay') && actor.environment !== input.environment) return '认证身份环境与选中运行环境不一致';
  return undefined;
}
