import { boundedText, type EvidencePresenter, type PresentedEvidence } from '@crosscheck/agent';
import type { EvidenceStore } from './store';

/** 每个实际候选独立核验并物化；未声明图片能力默认不附截图，不把 PNG 序列化成文本。 */
export function createEvidencePresenter(store: EvidenceStore, options: { maxTextChars?: number; capabilities?: Readonly<Record<string, { images: boolean }>> } = {}): EvidencePresenter {
  const maxTextChars = options.maxTextChars ?? 16000;
  boundedText('', maxTextChars);
  return async (ids, context) => {
    const output: PresentedEvidence[] = [];
    for (const id of ids) {
      context.signal.throwIfAborted();
      const type = await store.readEvidenceType(id);
      if (type === 'screenshot') {
        // 无图候选也核验已登记图片，坏盘/篡改不能被当成普通能力缺失吞掉。
        const evidence = await store.readScreenshotEvidence(id);
        context.signal.throwIfAborted();
        if (options.capabilities?.[context.ref]?.images === true) output.push({ ...evidence, truncated: false });
      } else {
        const evidence = await store.readTextEvidence(id);
        context.signal.throwIfAborted();
        const bounded = boundedText(evidence.text, maxTextChars);
        output.push({ id: evidence.id, type: evidence.type, text: bounded.text, truncated: evidence.sourceIncomplete || bounded.truncated });
      }
    }
    return output;
  };
}
