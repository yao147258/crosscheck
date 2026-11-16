import { boundedText, type EvidencePresenter } from '@crosscheck/agent';
import type { EvidenceStore } from './store';

/** 文本证据宿主适配器；agent/core/models 无需依赖工具包或磁盘实现。 */
export function createEvidencePresenter(store: EvidenceStore, options: { maxTextChars?: number } = {}): EvidencePresenter {
  const maxTextChars = options.maxTextChars ?? 16000;
  boundedText('', maxTextChars);
  return async (ids, context) => {
    const output = [];
    for (const id of ids) {
      context.signal.throwIfAborted();
      const evidence = await store.readTextEvidence(id);
      context.signal.throwIfAborted();
      const bounded = boundedText(evidence.text, maxTextChars);
      output.push({ id: evidence.id, type: evidence.type, text: bounded.text, truncated: evidence.sourceIncomplete || bounded.truncated });
    }
    return output;
  };
}
