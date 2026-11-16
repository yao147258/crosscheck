/// <reference lib="dom" />
import type { Page } from 'playwright';
import { ArtifactError } from '@crosscheck/core';
import type { DomNode } from '../evidence/sanitize-dom';

const controls = new WeakSet<DomNode>();
export function isCapturedControl(node: DomNode): boolean { return controls.has(node); }
import type { EvidenceRedactor } from '../evidence/redactor';

export interface MaskedCapture { readonly kind: 'masked-capture' }
const trusted = new WeakMap<object, { bytes: Buffer; redactor: EvidenceRedactor; sourceIncomplete: boolean }>();
export function readTrustedCapture(value: unknown, redactor: EvidenceRedactor): { bytes: Buffer; sourceIncomplete: boolean } {
  const capture = value && typeof value === 'object' ? trusted.get(value) : undefined;
  if (!capture || capture.redactor !== redactor) throw new ArtifactError('截图不是当前可信采集器的产物');
  return { bytes: Buffer.from(capture.bytes), sourceIncomplete: capture.sourceIncomplete };
}

/** 固定宿主脚本保留文本顺序和祖先关系；零盒子不是不可见子树。 */
export async function capturePage(page: Page, redactor: EvidenceRedactor, screenshotMasks: string[] = []): Promise<{ dom: DomNode[]; screenshot: MaskedCapture }> {
  const snapshot = await page.evaluate(selectors => {
    const nodes: { tag: string; type?: string; name?: string; text: string; value?: string; selector: string; attributes: string[]; opaque: boolean; approved: boolean; box: boolean; parent: number; parts: (string | number)[]; incomplete: boolean }[] = [];
    let overflow = false;
    function visit(element: Element, parent: number, selector: string): number | undefined {
      if (['script', 'style', 'head', 'meta', 'link', 'title'].includes(element.localName)) return;
      if (nodes.length >= 2000) { overflow = true; return; }
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      if (style.display === 'none') return;
      // visibility 可由后代恢复；只跳过当前节点的不可见文字，不剪枝。
      const visible = style.visibility === 'visible';
      const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
      const text = visible ? [...element.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent ?? '').join('') : '';
      const i = nodes.length;
      const node = { tag: element.localName, type: input && 'type' in element ? String(element.type) : undefined, name: element.getAttribute('name') ?? undefined,
        text: text.length <= 2000 ? text : '', value: input && element.value.length <= 2000 ? element.value : undefined, selector,
        attributes: [...element.attributes].map(a => a.value).concat(input ? element.value : '', ['::before', '::after'].map(p => getComputedStyle(element, p).content)),
        opaque: input || element.localName.includes('-') || !!element.shadowRoot || ['iframe', 'frame', 'canvas', 'svg', 'object', 'embed', 'img', 'video', 'audio'].includes(element.localName) || style.backgroundImage !== 'none',
        approved: selectors.some(s => element.matches(s)), box: rect.width > 0 && rect.height > 0, parent, parts: [] as (string | number)[], incomplete: text.length > 2000 || input && element.value.length > 2000 };
      nodes.push(node);
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { if (visible) node.parts.push((child.textContent ?? '').slice(0, 64001)); }
        else if (child instanceof Element) {
          const siblings = [...element.children].filter(e => e.localName === child.localName);
          const id = visit(child, i, `${selector} > ${CSS.escape(child.localName)}:nth-of-type(${siblings.indexOf(child) + 1})`);
          if (id !== undefined) node.parts.push(id);
        }
      }
      return i;
    }
    visit(document.documentElement, -1, 'html');
    return { nodes, overflow };
  }, screenshotMasks);
  const { nodes } = snapshot, hidden = new Set<number>(), roots = new Set<number>();
  const sensitiveText = (text: string) => redactor.displayText(text) !== text;
  const aggregate = (id: number): string => hidden.has(id) ? '' : nodes[id]!.parts.map(p => typeof p === 'string' ? p : aggregate(p)).join('').slice(0, 64001);
  const omit = (id: number) => {
    let mask = id;
    while (!nodes[mask]!.box && nodes[mask]!.parent >= 0) mask = nodes[mask]!.parent;
    roots.add(mask);
    const descendants = (n: number) => { hidden.add(n); for (const p of nodes[n]!.parts) if (typeof p === 'number') descendants(p); };
    descendants(mask);
  };
  // 不透明/批准区域先整体省略，后代不能重新成为扁平文本；随后从叶向根聚合余下文本。
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (!hidden.has(i) && (n.opaque || n.approved || n.incomplete || n.attributes.some(sensitiveText) || !!n.name && JSON.stringify(redactor.value({ [n.name]: 'probe' })).includes('[REDACTED]'))) omit(i);
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (hidden.has(i)) continue;
    const text = aggregate(i);
    if (text.length > 64000 || sensitiveText(text)) omit(i);
  }
  const dom: DomNode[] = nodes.flatMap((n, i) => {
    if (hidden.has(i) && !roots.has(i)) return [];
    const control = ['input', 'textarea', 'select'].includes(n.tag) && roots.has(i) && !n.approved && !n.incomplete
      && ![...roots].some(other => other !== i && n.selector.startsWith(nodes[other]!.selector + ' > '));
    const node: DomNode = { tag: n.tag, type: n.type, name: n.name,
      ...(control ? {} : { text: n.text.trim(), value: n.value }),
      locator: { strategy: 'css', value: n.selector }, sensitive: hidden.has(i),
      ...(hidden.has(i) ? { omissionReason: n.incomplete ? 'limit' : control ? 'redacted-value' : 'masked-region' } : {}) };
    if (control) controls.add(node);
    return [node];
  });
  const masks = [...roots].filter(i => ![...roots].some(other => other !== i && nodes[i]!.selector.startsWith(nodes[other]!.selector + ' > '))).map(i => nodes[i]!.selector);
  if (snapshot.overflow) { masks.push('html'); dom.push({ tag: 'observation', incomplete: true, omissionReason: 'limit' }); }
  // mask 矩形不一定覆盖 overflow 字形；截图临时样式同时隐藏整个敏感子树，包含显式恢复 visible 的后代。
  // screenshot 的 style 仅在拍摄期间应用，Playwright 完成或失败后移除，不修改应用持久状态。
  const style = masks.map(s => `${s}, ${s} * { visibility: hidden !important; }`).join('\n');
  const bytes = await page.screenshot({ type: 'png', mask: masks.map(s => page.locator(s)), style, maskColor: '#FF00FF', animations: 'disabled', caret: 'hide', timeout: 5000 });
  const screenshot = Object.freeze({ kind: 'masked-capture' as const });
  // 与 DOM 源省略语义一致；普通控件的批准值脱敏不是业务区域缺失。
  const sourceIncomplete = dom.some(node => node.incomplete || node.sensitive && node.omissionReason !== 'redacted-value');
  trusted.set(screenshot, { bytes: Buffer.from(bytes), redactor, sourceIncomplete });
  return { dom, screenshot };
}
