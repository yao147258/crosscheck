import type { VerifiedRunInputs } from '@crosscheck/core';
import { createEvidenceRedactor } from '@crosscheck/tools';

/** 只解析批准结构中的环境引用，不扫描或持久化宿主全部环境。 */
export function runRedactor(input: VerifiedRunInputs, env: Record<string, string | undefined>, secrets: string[] = []) {
  const refs = new Set<string>(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'DEEPSEEK_API_KEY']);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'env') {
        if (typeof child === 'string') refs.add(child);
        else if (child && typeof child === 'object') for (const ref of Object.values(child)) if (typeof ref === 'string') refs.add(ref);
      }
      visit(child);
    }
  };
  visit(input.profile); visit(input.config.providers);
  return createEvidenceRedactor(input.profile['guardrails.yaml'].redactFields, [...secrets, ...[...refs].flatMap(ref => env[ref] ? [env[ref]!] : [])]);
}
