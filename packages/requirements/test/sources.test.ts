import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clausesForDocuments, prepareDocuments } from '../src/sources';

const document = { file: 'docs/需求.md', text: '# 需求\n必须登录\n然后验证' };
const clause = (line: number, excerpt: string, file = document.file, id = 'M01-AC-001') => ({
  id, text: '必须登录', source: { file, line, excerpt },
});

describe('prepareDocuments', () => {
  it('规范化 CRLF 且不修改调用方文档', () => {
    const docs = [{ file: 'req.md', text: '第一行\r\n第二行' }];
    expect(prepareDocuments('M01', docs)).toEqual([{ file: 'req.md', text: '第一行\n第二行' }]);
    expect(docs[0]?.text).toBe('第一行\r\n第二行');
  });

  it.each(['', 'M-01', '../x', '模块', 'M 01', 'M01\n'])('拒绝非法模块 %j', (module) => {
    expect(() => prepareDocuments(module, [document])).toThrow();
  });

  it('拒绝空数组、空正文和重复文件', () => {
    expect(() => prepareDocuments('M01', [])).toThrow();
    expect(() => prepareDocuments('M01', [{ file: 'a', text: '' }])).toThrow();
    expect(() => prepareDocuments('M01', [document, document])).toThrow();
  });

  it.each(['', '/etc/passwd', '../a', 'a/../b', 'a\\b', 'C:/x', 'a//b', './a', 'a/'])('拒绝非法来源标识 %j', (file) => {
    expect(() => prepareDocuments('M01', [{ file, text: '内容' }])).toThrow();
  });

  it('按 UTF-8 字节限制单文档大小并允许边界', () => {
    expect(() => prepareDocuments('M01', [{ file: 'a', text: 'a'.repeat(1048576) }])).not.toThrow();
    expect(() => prepareDocuments('M01', [{ file: 'a', text: 'a'.repeat(1048576) + '中' }])).toThrow();
  });

  it('限制文档总大小并允许边界', () => {
    const text = 'a'.repeat(1048576);
    expect(() => prepareDocuments('M01', [{ file: 'a', text }, { file: 'b', text }])).not.toThrow();
    expect(() => prepareDocuments('M01', [{ file: 'a', text }, { file: 'b', text }, { file: 'c', text: 'x' }])).toThrow();
  });

  it('入口错误不泄露文档内容', () => {
    const secret = 'SECRET_文档全文';
    try {
      prepareDocuments('非法模块', [{ file: 'a', text: secret }]);
      throw new Error('应当拒绝');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe('clausesForDocuments', () => {
  it('保留单行来源并补全核心 schema 默认值', () => {
    const result = clausesForDocuments('M01', [document]).parse([clause(2, '必须登录')]);
    expect(result).toEqual([{ ...clause(2, '必须登录'), status: 'active', notes: '' }]);
  });

  it('允许从行中间开始并跨行精确引用', () => {
    expect(clausesForDocuments('M01', [document]).safeParse([clause(2, '登录\n然后')]).success).toBe(true);
  });

  it('将文档与摘录的 CRLF 都规范化为 LF', () => {
    const schema = clausesForDocuments('M01', [{ file: 'a', text: '第一行\r\n第二行' }]);
    expect(schema.parse([clause(1, '一行\r\n第二行', 'a')])[0]?.source.excerpt).toBe('一行\n第二行');
  });

  it.each([
    [1, '必须登录'], [2, '然后验证'], [4, '必须登录'], [0, '必须登录'],
    [2, ''], [2, '虚构内容'], [2, '必须登录\n虚构'],
  ])('拒绝错误行号或摘录 line=%i excerpt=%j', (line, excerpt) => {
    expect(clausesForDocuments('M01', [document]).safeParse([clause(line, excerpt)]).success).toBe(false);
  });

  it('拒绝缺失文件、其他模块以及重复条款 ID', () => {
    const schema = clausesForDocuments('M01', [document]);
    expect(schema.safeParse([clause(2, '必须登录', 'other.md')]).success).toBe(false);
    expect(schema.safeParse([clause(2, '必须登录', document.file, 'M02-AC-001')]).success).toBe(false);
    expect(schema.safeParse([clause(2, '必须登录'), clause(2, '必须登录')]).success).toBe(false);
  });

  it('重复 ID 的错误不回显模型提交的正文', () => {
    const secret = '敏感正文_测试标记';
    const schema = clausesForDocuments('M01', [{ file: 'a', text: secret }]);
    const item = clause(1, secret, 'a', secret);
    const result = schema.safeParse([item, item]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('重复'))).toBe(true);
      expect(JSON.stringify(result.error.issues)).not.toContain(secret);
    }
  });

  it('可将输入 schema 转换为 JSON Schema', () => {
    const json = z.toJSONSchema(clausesForDocuments('M01', [document]), { io: 'input' });
    expect(json.type).toBe('array');
    expect(json.items).toMatchObject({ type: 'object' });
  });

  it('来源校验失败提供可定位的结构化反馈，不包含文档正文', () => {
    const secret = 'SECRET_文档全文';
    const schema = clausesForDocuments('M01', [{ file: 'a', text: secret }]);
    const result = schema.safeParse([clause(1, '不存在', 'a')]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === '0.source.excerpt')).toBe(true);
      expect(JSON.stringify(result.error.issues)).not.toContain(secret);
    }
  });

  it('构造 schema 时同样验证输入', () => {
    expect(() => clausesForDocuments('非法', [document])).toThrow();
    expect(() => clausesForDocuments('M01', [])).toThrow();
  });
});
