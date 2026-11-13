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
  return unescapeSlashes(text)
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>\\]+/gi, (value) => {
      try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[已隐藏URL]';
      }
    })
    .replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi, `$1: ${hidden}`)
    .replace(/\b([A-Za-z_][A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|credential)[A-Za-z0-9_-]*|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|credential)(?:\\?["'])?\s*:\s*(?:\\?["'][^\r\n]*|[^\s,;}]+)/gi, `$1: ${hidden}`)
    // 带引号的值可能经过多层 shell/JSON 转义；保守遮盖至行尾，不尝试恢复命令。
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|credential)[A-Za-z0-9_]*|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|credential)\s*=\s*(?:\\*["'][^\r\n]*|[^\s,;]+)/gi, `$1=${hidden}`)
    .replace(/(--(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key)(?:=|\s+))(?:\\*["'][^\r\n]*|[^\s,;]+)/gi, `$1${hidden}`);
}
