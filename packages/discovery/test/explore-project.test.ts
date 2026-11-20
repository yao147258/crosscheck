import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetTracker } from '@crosscheck/core';
import { scriptedModel, type ScriptStep } from '../../agent/src/testing/scripted-model';
import { exploreProject, walkProject, type DiscoveryFact } from '../src/index';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'explore-'));
  await mkdir(join(root, 'server'));
  await writeFile(join(root, 'server/app.ts'), "const app = express();\napp.get('/health', handler);\n");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const known: DiscoveryFact = { kind: 'port', plugin: 'static-scan', port: 3000, source: { file: 'docker-compose.yml', line: 3, excerpt: '3000:3000' } };
const finish = (findings: unknown[]): ScriptStep => ({ toolCalls: [{ name: 'finish', input: { findings } }] });
const options = async (model: ReturnType<typeof scriptedModel>) => ({
  projectRoot: root, files: (await walkProject(root)).files, facts: [known], notes: '# 笔记\npassword=notesecret',
  models: [{ ref: 'mock:extractor', model }],
  budget: () => new BudgetTracker({ steps: 10, tokens: 100000, minutes: 1 }),
  resilience: { retries: 0, sleep: async () => {} },
});
function payload(model: ReturnType<typeof scriptedModel>) {
  const user = model.doGenerateCalls[0]!.prompt.find((message) => message.role === 'user');
  if (user?.role !== 'user' || user.content[0]?.type !== 'text') throw new Error('缺少用户文本消息');
  return JSON.parse(user.content[0].text);
}

describe('exploreProject', () => {
  it('读取文件后提交发现，核验通过的成为事实，不通过的记诊断', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'server/app.ts' } }] },
      finish([
        { kind: 'api', method: 'GET', path: '/health', summary: '健康检查', source: { file: 'server/app.ts', line: 2, excerpt: "app.get('/health'" } },
        { kind: 'api', method: 'POST', path: '/fake', source: { file: 'server/app.ts', line: 9, excerpt: 'app.post' } },
      ]),
    ]);
    const result = await exploreProject(await options(model));
    expect(result).toMatchObject({ status: 'done', diagnostics: ['发现来源核验失败已丢弃：api server/app.ts:9'] });
    if (result.status !== 'done') throw new Error('应完成');
    expect(result.facts).toEqual([{ kind: 'api', plugin: 'agent', method: 'GET', path: '/health', summary: '健康检查', parameters: [], servers: [], source: { file: 'server/app.ts', line: 2, excerpt: "app.get('/health', handler);" } }]);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("2: app.get('/health', handler);");
  });
  it('首条消息包含目录概览、已知事实与脱敏笔记', async () => {
    const model = scriptedModel([finish([])]);
    expect(await exploreProject(await options(model))).toEqual({ status: 'done', facts: [], diagnostics: [] });
    const data = payload(model);
    expect(data.overview).toContain('server/app.ts');
    expect(data.knownFacts).toEqual(['port 3000 (docker-compose.yml:3)']);
    expect(data.notes).toContain('# 笔记');
    expect(data.notes).not.toContain('notesecret');
  });
  it('输出不合法时报告失败', async () => {
    const bad: ScriptStep = { text: '不调用工具' };
    const model = scriptedModel([bad, bad, bad]);
    expect(await exploreProject(await options(model))).toMatchObject({ status: 'failed', interrupted: false });
  });
  it('预先取消时报告中断且不调用模型', async () => {
    const model = scriptedModel([]);
    expect(await exploreProject({ ...await options(model), signal: AbortSignal.abort() })).toMatchObject({ status: 'failed', interrupted: true });
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
