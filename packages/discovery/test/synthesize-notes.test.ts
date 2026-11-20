import { describe, expect, it } from 'vitest';
import { BudgetTracker, NotesTextSchema } from '@crosscheck/core';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import { synthesizeNotes } from '../src/index';

const finish = (markdown: string): ScriptStep => ({ toolCalls: [{ name: 'finish', input: { markdown } }] });
const options = (model: ReturnType<typeof scriptedModel>) => ({
  files: [{ path: 'README.md', bytes: 12 }],
  diagnostics: ['摘录已截断'],
  models: [{ ref: 'mock:extractor', model }],
  budget: () => new BudgetTracker({ steps: 10, tokens: 100000, minutes: 1 }),
  resilience: { retries: 0, sleep: async () => {} },
});
function payload(model: ReturnType<typeof scriptedModel>) {
  const user = model.doGenerateCalls[0]!.prompt.find((message) => message.role === 'user');
  if (user?.role !== 'user' || user.content[0]?.type !== 'text') throw new Error('缺少用户文本消息');
  return JSON.parse(user.content[0].text);
}

describe('项目笔记合成', () => {
  it('共享校验按 UTF-8 字节限制、非空和 Markdown 标题判断', () => {
    const boundary = '# ' + '中'.repeat(21844) + 'ab';
    expect(Buffer.byteLength(boundary)).toBe(65536);
    expect(NotesTextSchema.safeParse(boundary).success).toBe(true);
    expect(NotesTextSchema.safeParse(boundary + '中').success).toBe(false);
    expect(NotesTextSchema.safeParse('').success).toBe(false);
    expect(NotesTextSchema.safeParse('没有标题').success).toBe(false);
  });
  it('发送清单和诊断，缺省时不发送旧笔记', async () => {
    const model = scriptedModel([finish('# 项目笔记\n\n正文')]);
    expect(await synthesizeNotes(options(model))).toEqual({ status: 'done', text: '# 项目笔记\n\n正文', interrupted: false });
    expect(payload(model)).toEqual({ manifest: [{ path: 'README.md', bytes: 12 }], diagnostics: ['摘录已截断'] });
  });
  it('模型调用前清理路径、诊断和旧笔记中的已知凭证', async () => {
    const model = scriptedModel([finish('# 笔记')]);
    await synthesizeNotes({ ...options(model), files: [{ path: 'token=pathsecret/file.md', bytes: 5 }], diagnostics: ['secret=diagsecret'], previous: '# 旧笔记\napi_key=previoussecret' });
    const data = payload(model);
    expect(JSON.stringify(data)).not.toMatch(/pathsecret|diagsecret|previoussecret/);
    expect(data.manifest[0].path).toContain('[已隐藏]');
    expect(data.diagnostics[0]).toContain('[已隐藏]');
    expect(data.previous).toContain('[已隐藏]');
  });
  it('刷新前对旧笔记多行敏感值脱敏', async () => {
    const model = scriptedModel([finish('# 笔记')]);
    await synthesizeNotes({ ...options(model), previous: '# 旧笔记\npassword: |2-\n  old-secret\nsafe: yes' });
    expect(payload(model).previous).not.toContain('old-secret');
    expect(payload(model).previous).toContain('safe: yes');
  });
  it('无效标题和超出字节上限的输出经本地校验后重试', async () => {
    const model = scriptedModel([finish('无标题'), finish('# ' + '中'.repeat(21845)), finish('# 正确')]);
    expect(await synthesizeNotes(options(model))).toEqual({ status: 'done', text: '# 正确', interrupted: false });
    expect(model.doGenerateCalls).toHaveLength(3);
  });
  it('连续无效输出最终失败', async () => {
    const model = scriptedModel([finish(''), finish('无标题'), finish('# ' + '中'.repeat(21845))]);
    expect(await synthesizeNotes(options(model))).toMatchObject({ status: 'failed', reason: 'invalid-output', interrupted: false });
  });
  it('多字节内容恰好达到字节上限时可通过代理', async () => {
    const text = '# ' + '中'.repeat(21844) + 'ab';
    const model = scriptedModel([finish(text)]);
    expect(await synthesizeNotes(options(model))).toEqual({ status: 'done', text, interrupted: false });
  });
  it('模型为空时抛错，预先取消时报告中断', async () => {
    const model = scriptedModel([{ hang: true }]);
    await expect(synthesizeNotes({ ...options(model), models: [] })).rejects.toThrow('模型列表不能为空');
    expect(await synthesizeNotes({ ...options(model), signal: AbortSignal.abort() })).toMatchObject({ status: 'failed', reason: 'interrupted', interrupted: true });
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
