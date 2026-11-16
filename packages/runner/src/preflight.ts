import type { TestCase, VerifiedRunInputs } from '@crosscheck/core';

/** 只看批准后的结构化字段；自然语言页面步骤不构成浏览器准入判据。 */
export function preflight(input: VerifiedRunInputs, tc: TestCase): string | undefined {
  return input.selection.blocked.find(item => item.id === tc.id)?.reason;
}
