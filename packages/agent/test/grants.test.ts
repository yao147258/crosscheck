import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineTool, grantTools, type AgentTool, type ToolCategory } from '../src/index';

const mk = (name: string, category: ToolCategory): AgentTool =>
  defineTool({ name, category, description: name, input: z.object({}), execute: async () => null });

const all = [
  mk('browser_click', 'browser'),
  mk('http_request', 'http'),
  mk('db_query', 'db'),
  mk('fixture_apply', 'fixture'),
  mk('profile_lookup', 'profile'),
  mk('requirements_read', 'requirements'),
  mk('project_read', 'project'),
];

const names = (ts: AgentTool[]) => ts.map((t) => t.name);

describe('grantTools', () => {
  it('执行阶段不授予夹具工具', () => {
    const { granted, denied } = grantTools('execute', all);
    expect(names(granted)).toEqual(['browser_click', 'http_request', 'db_query', 'profile_lookup']);
    expect(names(denied)).toEqual(['fixture_apply', 'requirements_read', 'project_read']);
  });

  it('生成用例阶段只能读条款和画像，不能操作系统', () => {
    expect(names(grantTools('plan', all).granted)).toEqual(['profile_lookup', 'requirements_read']);
  });

  it('准备阶段可以使用夹具', () => {
    expect(names(grantTools('prepare', all).granted)).toContain('fixture_apply');
  });

  it('复核阶段没有任何工具', () => {
    expect(grantTools('review', all).granted).toEqual([]);
  });

  it('只有分析阶段可读项目文件', () => {
    expect(names(grantTools('extract', all).granted)).toEqual(['profile_lookup', 'project_read']);
    for (const stage of ['plan', 'prepare', 'execute', 'review'] as const) {
      expect(names(grantTools(stage, all).granted)).not.toContain('project_read');
    }
  });
});

describe('defineTool', () => {
  it('拒绝含点号等字符的名称', () => {
    expect(() => mk('profile.lookup', 'profile')).toThrow(/工具名/);
  });
});
