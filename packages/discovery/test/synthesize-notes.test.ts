import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetTracker, NotesTextSchema } from '@crosscheck/core';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import { synthesizeNotes, walkProject } from '../src/index';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'notes-'));
  await writeFile(join(root, 'README.md'), '# 演示项目\npassword=readmesecret\n');
  await writeFile(join(root, 'package.json'), '{\n  "scripts": { "dev": "vite --port 5173" }\n}\n');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const finish = (markdown: string): ScriptStep => ({ toolCalls: [{ name: 'finish', input: { markdown } }] });
const options = async (model: ReturnType<typeof scriptedModel>) => ({
  projectRoot: root,
  files: (await walkProject(root)).files,
  diagnostics: ['目录已截断'],
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
  it('首条消息包含目录概览、README 开头与诊断，缺省时不发送旧笔记', async () => {
    const model = scriptedModel([finish('# 项目笔记\n\n正文')]);
    expect(await synthesizeNotes(await options(model))).toEqual({ status: 'done', text: '# 项目笔记\n\n正文', interrupted: false });
    const data = payload(model);
    expect(data.overview).toContain('package.json');
    expect(data.readme[0]).toBe('# 演示项目');
    expect(data.diagnostics).toEqual(['目录已截断']);
    expect(data).not.toHaveProperty('previous');
    expect(JSON.stringify(data)).not.toContain('readmesecret');
  });
  it('模型可先读取文件再提交，工具结果回传给模型', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'read_file', input: { path: 'package.json' } }] }, finish('# 笔记')]);
    expect(await synthesizeNotes(await options(model))).toMatchObject({ status: 'done', text: '# 笔记' });
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain('vite --port 5173');
  });
  it('调用方清理作用于概览、诊断、旧笔记和工具结果', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'read_file', input: { path: 'package.json' } }] }, finish('# 笔记')]);
    await synthesizeNotes({ ...await options(model), diagnostics: ['vite 诊断'], previous: '# 旧笔记\nvite', clean: (text) => text.replaceAll('vite', '[密钥]') });
    expect(JSON.stringify(model.doGenerateCalls.map((call) => call.prompt))).not.toContain('vite');
  });
  it('刷新前对旧笔记多行敏感值脱敏', async () => {
    const model = scriptedModel([finish('# 笔记')]);
    await synthesizeNotes({ ...await options(model), previous: '# 旧笔记\npassword: |2-\n  old-secret\nsafe: yes' });
    expect(payload(model).previous).not.toContain('old-secret');
    expect(payload(model).previous).toContain('safe: yes');
  });
  it('无效标题和超出字节上限的输出经本地校验后重试', async () => {
    const model = scriptedModel([finish('无标题'), finish('# ' + '中'.repeat(21845)), finish('# 正确')]);
    expect(await synthesizeNotes(await options(model))).toEqual({ status: 'done', text: '# 正确', interrupted: false });
    expect(model.doGenerateCalls).toHaveLength(3);
  });
  it('连续无效输出最终失败', async () => {
    const model = scriptedModel([finish(''), finish('无标题'), finish('# ' + '中'.repeat(21845))]);
    expect(await synthesizeNotes(await options(model))).toMatchObject({ status: 'failed', reason: 'invalid-output', interrupted: false });
  });
  it('预算耗尽时报告 budget', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'list_dir', input: {} }] }, finish('# 笔记')]);
    const result = await synthesizeNotes({ ...await options(model), budget: () => new BudgetTracker({ steps: 1, tokens: 100000, minutes: 1 }) });
    expect(result).toMatchObject({ status: 'failed', reason: 'budget' });
  });
  it('模型为空时抛错，预先取消时报告中断', async () => {
    const model = scriptedModel([{ hang: true }]);
    await expect(synthesizeNotes({ ...await options(model), models: [] })).rejects.toThrow('模型列表不能为空');
    expect(await synthesizeNotes({ ...await options(model), signal: AbortSignal.abort() })).toMatchObject({ status: 'failed', reason: 'interrupted', interrupted: true });
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
