/** 可见转义单行终端文本中的反斜杠、控制字符、格式字符和换行，不改变原始记录。 */
export function escapeTerminalLine(text: string): string {
  return text.replace(/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => {
    if (char === '\\') return '\\\\';
    const hex = char.codePointAt(0)!.toString(16);
    return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
  });
}
