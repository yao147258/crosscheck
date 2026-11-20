import type { ProviderType } from '@crosscheck/core';
import type { ModelMessage, SystemModelMessage } from 'ai';

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

/** Anthropic 按 tools → system → messages 拼接：system 断点覆盖工具定义，历史末条断点覆盖已定稿前缀；附件在其后不入缓存。 */
export function applyCacheBreakpoints(system: string, messages: ModelMessage[], historyLength: number, providerType?: ProviderType): { system: string | SystemModelMessage; messages: ModelMessage[] } {
  if (providerType !== 'anthropic') return { system, messages };
  const out = [...messages];
  const last = Math.min(historyLength, out.length) - 1;
  if (last >= 0) {
    const message = out[last]!;
    out[last] = { ...message, providerOptions: { ...message.providerOptions, ...EPHEMERAL } } as ModelMessage;
  }
  return { system: { role: 'system', content: system, providerOptions: EPHEMERAL }, messages: out };
}
