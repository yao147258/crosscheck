import { AsyncLocalStorage } from 'node:async_hooks';

/** 进度监听器：接收一行面向用户的执行提示（模型请求、工具调用等）。 */
export type ProgressListener = (text: string) => void;

const storage = new AsyncLocalStorage<ProgressListener>();

/** 在异步上下文内登记进度监听器，fn 及其派生的异步调用中 reportProgress 都会送达该监听器。 */
export function withProgress<T>(listener: ProgressListener | undefined, fn: () => T): T {
  return listener ? storage.run(listener, fn) : fn();
}

/** 上报一行执行提示；没有监听器时静默忽略，监听器异常不影响实际执行。 */
export function reportProgress(text: string): void {
  try { storage.getStore()?.(text); } catch { /* 提示失败不能影响执行。 */ }
}

const SENSITIVE = /pass|secret|token|key|auth|cookie|credential|session/i;

/** 把工具输入概括为一行：只取顶层标量字段，跳过疑似敏感的字段与取值，并截断过长内容。 */
export function summarizeInput(input: unknown, max = 100): string {
  if (input === null || typeof input !== 'object') return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE.test(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const text = String(value).replace(/\s+/g, ' ');
    if (SENSITIVE.test(text)) continue;
    parts.push(`${key}=${text.length > 40 ? `${text.slice(0, 40)}…` : text}`);
  }
  const line = parts.join(', ');
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
