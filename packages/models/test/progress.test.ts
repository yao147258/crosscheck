import { expect, it } from 'vitest';
import { reportProgress, summarizeInput, withProgress } from '../src/progress';

it('进度只送达当前异步上下文的监听器，监听器异常不外抛', async () => {
  const a: string[] = [], b: string[] = [];
  await Promise.all([
    withProgress((line) => a.push(line), async () => { await Promise.resolve(); reportProgress('甲'); }),
    withProgress((line) => b.push(line), async () => { reportProgress('乙'); }),
  ]);
  reportProgress('无监听器');
  expect(a).toEqual(['甲']);
  expect(b).toEqual(['乙']);
  expect(() => withProgress(() => { throw new Error('坏监听器'); }, () => reportProgress('丙'))).not.toThrow();
});

it('概括工具输入时跳过敏感字段与非标量字段并截断', () => {
  expect(summarizeInput({ method: 'GET', path: '/api/items', password: 'p', headers: { a: 1 }, body: 'token=abc' })).toBe('method=GET, path=/api/items');
  expect(summarizeInput({ url: 'x'.repeat(60) })).toBe(`url=${'x'.repeat(40)}…`);
  expect(summarizeInput('文本')).toBe('');
});
