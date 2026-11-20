import { describe, expect, it } from 'vitest';
import { parseNotesRequirementDocs } from '../src/index';

describe('笔记“需求文档”小节解析', () => {
  it('没有该小节时返回空数组', () => {
    expect(parseNotesRequirementDocs('# 笔记\n\n## 启动方式\n\n- `pnpm dev`\n')).toEqual([]);
  });
  it('提取反引号内的路径并忽略说明文字', () => {
    const text = '# 笔记\n\n## 需求文档\n\n- `docs/prd/` 产品需求\n- `README.md` 项目说明\n\n## 其他\n\n- `不应读取.md`\n';
    expect(parseNotesRequirementDocs(text)).toEqual(['docs/prd/', 'README.md']);
  });
  it('“未发现”与反引号之外的行不产生条目', () => {
    expect(parseNotesRequirementDocs('# 笔记\n\n## 需求文档\n\n未发现\n- docs/a.md 没有反引号\n')).toEqual([]);
  });
  it('遇到下一个标题结束，支持 * 列表、CRLF、去重和尾部井号标题', () => {
    const text = '# 笔记\r\n\r\n## 需求文档 ##\r\n\r\n* `a.md`\r\n- `a.md`\r\n- `b/`\r\n\r\n## 后续\r\n- `c.md`\r\n';
    expect(parseNotesRequirementDocs(text)).toEqual(['a.md', 'b/']);
  });
  it('其他标题层级的“需求文档”也识别，空反引号被忽略', () => {
    expect(parseNotesRequirementDocs('# 笔记\n\n### 需求文档\n- `x.md`\n- `  `\n')).toEqual(['x.md']);
  });
});
