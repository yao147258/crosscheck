import type { EvidenceRedactor } from './redactor';

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
}

/** 采集器必须遍历可见节点并标记获批 selector；不接收原始 HTML。 */
export function sanitizeDom(nodes: DomNode[], r: EvidenceRedactor): unknown[] {
  return nodes.map(node => {
    const tag = node.tag.toLowerCase();
    const unsafe = ['iframe', 'frame', 'canvas', 'object', 'embed', 'svg'].includes(tag);
    const sensitive = unsafe || node.omitted || node.sensitive || node.approvedSelectorMatch || node.type?.toLowerCase() === 'password' || (node.name && JSON.stringify(r.value({ [node.name]: 'probe' })).includes('[REDACTED]')) || (node.text && r.text(node.text) !== node.text) || (node.value && r.text(node.value) !== node.value);
    if (sensitive) return { tag: r.text(tag), omitted: true, ...(node.locator ? { locator: r.value(node.locator), ...(node.type ? { type: r.text(node.type) } : {}), ...(node.name ? { name: r.text(node.name) } : {}) } : {}) };
    return { tag: r.text(tag), ...(node.locator ? { locator: r.value(node.locator) } : {}), ...(node.incomplete ? { incomplete: true } : {}), ...(node.type ? { type: r.text(node.type) } : {}), ...(node.name ? { name: r.text(node.name) } : {}), ...(node.text ? { text: r.text(node.text) } : {}), ...(node.value ? { value: r.text(node.value) } : {}), ...(node.children ? { children: sanitizeDom(node.children, r) } : {}) };
  });
}
