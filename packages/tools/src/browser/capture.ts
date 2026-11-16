/// <reference lib="dom" />
import type { Page } from 'playwright';
import { ArtifactError } from '@crosscheck/core';
import type { DomNode } from '../evidence/sanitize-dom';
import type { EvidenceRedactor } from '../evidence/redactor';

export interface MaskedCapture { readonly kind: 'masked-capture' }
const trusted = new WeakMap<object, { bytes: Buffer; redactor: EvidenceRedactor }>();

/** 只有本模块的真实采集结果能兑换 PNG；不接受结构相同的对象或调用者提供的 bytes。 */
export function readTrustedCapture(value: unknown, redactor: EvidenceRedactor): Buffer {
  const capture = value && typeof value === 'object' ? trusted.get(value) : undefined;
  if (!capture || capture.redactor !== redactor) throw new ArtifactError('截图不是当前可信采集器的产物');
  return Buffer.from(capture.bytes);
}

/** 仅宿主执行固定采集脚本，模型不能传脚本；可视快照有界，未知可视载荷保守遮罩。 */
export async function capturePage(page: Page, redactor: EvidenceRedactor, screenshotMasks: string[] = []): Promise<{ dom: DomNode[]; screenshot: MaskedCapture }> {
  const snapshot = await page.evaluate(() => {
    const nodes: { tag: string; type?: string; name?: string; text?: string; value?: string; selector: string; attributes: string[]; opaque: boolean }[] = [];
    const selector = (element: Element): string => {
      const parts: string[] = []; let current: Element | null = element;
      while (current) {
        const tag = current.localName;
        const siblings: Element[] = current.parentElement ? [...current.parentElement.children].filter(e => e.localName === tag) : [current];
        parts.unshift(`${CSS.escape(tag)}:nth-of-type(${siblings.indexOf(current) + 1})`);
        current = current.parentElement;
      }
      return parts.join(' > ');
    };
    let overflow = false;
    for (const element of document.querySelectorAll('*')) {
      if (nodes.length >= 2000) { overflow = true; break; }
      if (['script', 'style', 'head', 'meta', 'link', 'title'].includes(element.localName)) continue;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
      const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
      const directText = [...element.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent ?? '').join(' ').trim();
      const pseudo = ['::before', '::after'].map(p => getComputedStyle(element, p).content).join(' ');
      nodes.push({ tag: element.localName, type: input && 'type' in element ? String(element.type) : undefined, name: element.getAttribute('name') ?? undefined,
        text: directText.slice(0, 2000), value: input ? element.value.slice(0, 2000) : undefined, selector: selector(element),
        attributes: [...element.attributes].map(a => `${a.name}=${a.value}`).concat(directText, input ? element.value : '', pseudo),
        opaque: input || element.localName.includes('-') || !!element.shadowRoot || ['iframe', 'frame', 'canvas', 'svg', 'object', 'embed', 'img', 'video', 'audio'].includes(element.localName) || style.backgroundImage !== 'none' || directText.length > 2000 });
    }
    return { nodes, overflow };
  });
  const maskSelectors = new Set<string>(['input', 'textarea', 'select', 'iframe', 'frame', 'canvas', 'svg', 'object', 'embed', 'img', 'video', 'audio', ...screenshotMasks]);
  const dom: DomNode[] = [];
  for (const node of snapshot.nodes) {
    const approved = screenshotMasks.length > 0 && await page.locator(node.selector).evaluate((element, selectors) => selectors.some(s => element.matches(s) || !!element.closest(s)), screenshotMasks);
    const sensitive = node.opaque || approved || node.attributes.some(value => redactor.text(value) !== value) || !!node.name && JSON.stringify(redactor.value({ [node.name]: 'probe' })).includes('[REDACTED]');
    if (sensitive) maskSelectors.add(node.selector);
    dom.push({ tag: node.tag, type: node.type, name: node.name, text: node.text, value: node.value, locator: { strategy: 'css', value: node.selector }, sensitive });
  }
  if (snapshot.overflow) { maskSelectors.add('html'); dom.push({ tag: 'observation', text: '[omitted: DOM node limit]', incomplete: true }); }
  const bytes = await page.screenshot({ type: 'png', mask: [...maskSelectors].map(s => page.locator(s)), maskColor: '#FF00FF', animations: 'disabled', caret: 'hide', timeout: 5000 });
  const screenshot = Object.freeze({ kind: 'masked-capture' as const });
  trusted.set(screenshot, { bytes: Buffer.from(bytes), redactor });
  return { dom, screenshot };
}
