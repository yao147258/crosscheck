import type { EvidenceRedactor } from './redactor';
import { isCapturedControl } from '../browser/capture';

export interface DomNode {
  tag: string;
  type?: string;
  name?: string;
  text?: string;
  value?: string;
  sensitive?: boolean;
  approvedSelectorMatch?: boolean;
  children?: DomNode[];
  locator?: { strategy: 'css'; value: string };
  incomplete?: boolean;
  omitted?: boolean;
  /** redacted 表示已知值替换；omitted/limit 表示观察内容确实缺失。 */
  omissionReason?: 'masked-region' | 'limit' | 'redacted-value';
}

/** 重读仅在仓库核验已登记哈希后信任已保存的值脱敏标记。 */
export function sanitizeDom(nodes: DomNode[], r: EvidenceRedactor, verified = false): unknown[] {
  return nodes.map(node => {
    const tag = node.tag.toLowerCase();
    const unsafe = ['iframe', 'frame', 'canvas', 'object', 'embed', 'svg', 'img'].includes(tag);
    const control = ['input', 'textarea', 'select'].includes(tag) && node.omissionReason === 'redacted-value' && (isCapturedControl(node) || verified) && !node.incomplete && !node.approvedSelectorMatch;
    if (control) return { tag, omitted: true, omissionReason: 'redacted-value', ...(node.locator ? { locator: r.value(node.locator) } : {}), ...(node.type ? { type: r.text(node.type) } : {}), ...(node.name ? { name: r.text(node.name) } : {}) };
    const sensitive = unsafe || node.omitted || node.sensitive || node.approvedSelectorMatch || node.type?.toLowerCase() === 'password' || (node.name && JSON.stringify(r.value({ [node.name]: 'probe' })).includes('[REDACTED]')) || (node.text && r.displayText(node.text) !== node.text) || (node.value && r.displayText(node.value) !== node.value);
    if (sensitive) return { tag: r.text(tag), omitted: true, ...(node.omissionReason ? { omissionReason: node.omissionReason === 'redacted-value' ? 'masked-region' : node.omissionReason } : {}), ...(node.incomplete ? { incomplete: true } : {}), ...(node.locator ? { locator: r.value(node.locator), ...(node.type ? { type: r.text(node.type) } : {}), ...(node.name ? { name: r.text(node.name) } : {}) } : {}) };
    return { tag: r.text(tag), ...(node.locator ? { locator: r.value(node.locator) } : {}), ...(node.incomplete ? { incomplete: true } : {}), ...(node.type ? { type: r.text(node.type) } : {}), ...(node.name ? { name: r.text(node.name) } : {}), ...(node.text ? { text: r.displayText(node.text) } : {}), ...(node.value ? { value: r.displayText(node.value) } : {}), ...(node.children ? { children: sanitizeDom(node.children, r, verified) } : {}) };
  });
}
