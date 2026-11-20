import { EventEmitter } from 'node:events';
import { createElement, type ReactElement } from 'react';
import { render as inkRender } from 'ink';

export const KEYS = { up: '\u001B[A', down: '\u001B[B', enter: '\r', escape: '\u001B', tab: '\t', pageUp: '\u001B[5~', pageDown: '\u001B[6~' };

// ink-testing-library 以 debug 模式渲染，绕过 log-update 不产生光标转义；
// 需要断言终端光标行为时使用 debug=false 的自定义渲染。
class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 24;
  frames: string[] = [];
  write = (data: string) => { this.frames.push(data); };
}
class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write = (data: string) => { this.data = data; this.emit('readable'); this.emit('data', data); };
  setEncoding() { /* 测试用空实现 */ }
  setRawMode() { /* 测试用空实现 */ }
  resume() { /* 测试用空实现 */ }
  pause() { /* 测试用空实现 */ }
  ref() { /* 测试用空实现 */ }
  unref() { /* 测试用空实现 */ }
  read = () => { const { data } = this; this.data = null; return data; };
}

export function renderInteractive(tree: ReactElement) {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  // 测试桩只需满足 ink 实际调用的 stdin/stdout 子集，这里断言为 ReadStream 类型。
  const instance = inkRender(tree, { stdout: stdout as never, stdin: stdin as never, debug: false, exitOnCtrlC: false, patchConsole: false });
  return {
    stdout,
    stdin,
    writes: () => stdout.frames.join(''),
    unmount: () => instance.unmount(),
  };
}

export function terminalSnapshot(output: string, columns = 100, rows = 24) {
  const lines = Array.from({ length: rows }, () => Array<string>(columns).fill(' '));
  let x = 0, y = 0, visible = false;
  const newline = () => {
    x = 0;
    if (++y >= rows) { lines.shift(); lines.push(Array<string>(columns).fill(' ')); y = rows - 1; }
  };
  for (const token of output.match(/\u001b\[[0-?]*[ -/]*[@-~]|[^\u001b]/gu) ?? []) {
    if (token.startsWith('\u001b[')) {
      const command = token.at(-1);
      const values = token.slice(2, -1).split(';').map(Number);
      const count = values[0] || 1;
      if (command === 'A') y = Math.max(0, y - count);
      else if (command === 'B') y = Math.min(rows - 1, y + count);
      else if (command === 'G') x = count - 1;
      else if (command === 'H') { y = count - 1; x = (values[1] || 1) - 1; }
      else if (command === 'K') lines[y]!.fill(' ', values[0] === 2 ? 0 : x);
      else if (command === 'J' && values[0] === 2) for (const line of lines) line.fill(' ');
      else if (token === '\u001b[?25h') visible = true;
      else if (token === '\u001b[?25l') visible = false;
      continue;
    }
    if (token === '\n') { newline(); continue; }
    if (token === '\r') { x = 0; continue; }
    if (x >= columns) newline();
    const width = (token.codePointAt(0) ?? 0) >= 0x1100 && !/[─-╿]/.test(token) ? 2 : 1;
    lines[y]![x] = token;
    if (width === 2) lines[y]![x + 1] = '';
    x += width;
  }
  return { x, y, visible, lines: lines.map(line => line.join('').trimEnd()) };
}

export async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
