const hidden = '[已隐藏]';

/**
 * 把 JSON/YAML 字符串里几种等价的 "/" 转义写法统一还原成字面 "/"。
 *
 * 根因：本文件和 openapi.ts 的清理规则都是按字面字符匹配 "//"、"://"。
 * 但 excerpt 等字段来自未经二次解析的原始源码行，`/` 在 JSON 里允许写成
 * `\/`，在 YAML 双引号标量里还可以写成 `/`/`\x2f`。原始文本里这些
 * 转义写法不含字面的 "/"，会让所有基于字面斜杠的规则直接判定“无需清理”，
 * 使 URL/凭证原样漏网。先统一解码成字面 "/" 再匹配，一次性堵住这一整类
 * 编码变体，而不是针对每种转义写法单独加规则。
 */
export function unescapeSlashes(text: string): string {
  return text.replace(/\\(?:\/|u002[fF]|x2[fF])/g, '/');
}

/** 对候选及其来源使用同一套保守的凭证清理规则。 */
export function sanitize(text: string): string {
  return sanitizeText(text, false);
}

function sanitizeText(text: string, preserveCleanUrls: boolean): string {
  return unescapeSlashes(text)
    .replace(/\b(?:https?|wss?):\/\/\S+/gi, (raw, offset: number, text: string) => {
      const opening = text[offset - 1];
      const closing = opening === '<' ? '>' : opening && ['"', "'", '`'].includes(opening) ? opening : undefined;
      const suffix = closing && raw.endsWith(closing) ? closing : '';
      const value = suffix ? raw.slice(0, -1) : raw;
      try {
        const url = new URL(value);
        if (preserveCleanUrls && !url.username && !url.password && !url.search && !url.hash) return raw;
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString() + suffix;
      } catch {
        return '[已隐藏URL]' + suffix;
      }
    })
    .replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi, `$1: ${hidden}`)
    .replace(/\b([A-Za-z_][A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|credential)[A-Za-z0-9_-]*|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|credential)(?:\\?["'])?\s*:\s*(?:\\?["'][^\r\n]*|[^\s,;}]+)/gi, `$1: ${hidden}`)
    // 带引号的值可能经过多层 shell/JSON 转义；保守遮盖至行尾，不尝试恢复命令。
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|credential)[A-Za-z0-9_]*|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|credential)\s*=\s*(?:\\*["'][^\r\n]*|[^\s,;]+)/gi, `$1=${hidden}`)
    .replace(/(--(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key)(?:=|\s+))(?:\\*["'][^\r\n]*|[^\s,;]+)/gi, `$1${hidden}`);
}

/** 清理完整文本，保留换行以便调用方维持来源行号。 */
export function sanitizeMultiline(text: string): string {
  let blockIndent: number | undefined;
  let quote: string | undefined;
  const sensitive = /^(\s*)(?:-\s*)?["']?[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|credential|authorization|cookie)[\w.-]*["']?\s*:\s*(.*)$/i;
  const closed = (text: string, delimiter: string) => {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === delimiter) {
        if (delimiter === "'" && text[i + 1] === "'") { i++; continue; }
        return true;
      }
    }
    return false;
  };
  return text.split('\n').map((line) => {
    if (quote) {
      if (closed(line, quote)) quote = undefined;
      return hidden;
    }
    if (blockIndent !== undefined) {
      if (!line.trim() || (line.match(/^\s*/)?.[0].length ?? 0) > blockIndent) return hidden;
      blockIndent = undefined;
    }
    const match = sensitive.exec(line);
    if (match) {
      const value = match[2]!.trimStart();
      if ((value[0] === '"' || value[0] === "'") && !closed(value.slice(1), value[0])) quote = value[0];
      else blockIndent = match[1]!.length;
      if (quote || /^[|>]/.test(value) || !value) return `${match[1]}${hidden}`;
    }
    return sanitizeContextLine(line);
  }).join('\n');
}

function sanitizeContextLine(value: string): string {
    const cleaned = unescapeSlashes(value).replace(/(?<!:)\/\/\S+/g, (raw, offset: number, text: string) => {
      if (!/[?#@]/.test(raw)) return raw;
      const opening = text[offset - 1];
      const closing = opening === '<' ? '>' : opening && ['"', "'", '`'].includes(opening) ? opening : undefined;
      const suffix = closing && raw.endsWith(closing) ? closing : '';
      const candidate = suffix ? raw.slice(0, -1) : raw;
      try {
        const url = new URL(`https:${candidate}`);
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.toString().slice(6) + suffix;
      } catch { return '[已隐藏URL]' + suffix; }
    });
    return sanitizeText(cleaned, true);
}

/** 只清理模型上下文副本，不修改原始画像；启发式规则不能替代已知密钥脱敏。 */
export function sanitizeContext<T>(value: T): T {
  if (typeof value === 'string') return sanitizeMultiline(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeContext) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [sanitizeContext(key), sanitizeContext(child)])) as T;
  }
  return value;
}
