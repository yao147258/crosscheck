import { Approvals, loadProfile, TestCaseSchema } from '@crosscheck/core';
import { runSuite } from '@crosscheck/runner';
import { MockLanguageModelV4 } from 'ai/test';
import { scriptedModel } from '../../agent/src/testing/scripted-model';
import { ReviewSession } from '../src/index';
import { clause, createProject } from './fixture';

const ids = (prompt: unknown) => [...new Set([...JSON.stringify(prompt).matchAll(/e-[a-f0-9-]{36}/g)].map((m) => m[0]!))];
const judgements = (verdicts: Record<string, string>, evidenceIds: string[], reasoning: string) => ({
  toolCalls: [{ name: 'finish', input: { judgements: Object.entries(verdicts).map(([expectationId, verdict]) => ({ expectationId, verdict, evidenceIds, reasoning })) } }],
});

/** 真实运行器、假模型及受控传输：不访问网络，E1 FAIL、E2 DISPUTED、E3 PASS。 */
export async function createFailedRun(clauseCount = 2) {
  const project = await createProject();
  const { artifacts } = project;
  const clauses = Array.from({ length: clauseCount }, (_, i) => clause(i + 1));
  const tc = TestCaseSchema.parse({
    id: 'M-TC-1', covers: clauses.map((c) => c.id), actor: 'guest', steps: ['GET /value'],
    expectations: [
      { id: 'E1', text: '值为 ok', evidence: ['network'] },
      { id: 'E2', text: '状态为 200', evidence: ['network'] },
      { id: 'E3', text: '响应存在', evidence: ['network'] },
    ],
  });
  await artifacts.saveClauses('M', clauses);
  await artifacts.saveCases('M', [tc]);
  const approvals = Approvals.empty();
  for (const [name, value] of Object.entries(await loadProfile(artifacts))) approvals.approve('profile', name, value, '人工');
  for (const c of clauses) approvals.approve('clause', c.id, c, '人工');
  approvals.approveCase(tc, clauses, '人工');
  await approvals.save(artifacts);
  project.session = await ReviewSession.open(artifacts, '测试人');

  let step = 0;
  const executor = new MockLanguageModelV4({ doGenerate: async (opts) => scriptedModel([
    step++ === 0
      ? { toolCalls: [{ name: 'http_request', input: { url: 'http://localhost:39999/value' } }] }
      : judgements({ E1: 'fail', E2: 'pass', E3: 'pass' }, ids(opts.prompt), '执行方理由'),
  ]).doGenerate(opts) });
  const reviewer = new MockLanguageModelV4({ doGenerate: async (opts) => scriptedModel([
    judgements({ E1: 'fail', E2: 'fail', E3: 'pass' }, ids(opts.prompt), '复核方理由'),
  ]).doGenerate(opts) });
  const outcome = await runSuite({
    artifacts, userConfigHome: project.userHome,
    modelOptions: { env: {}, factories: { openai: ({ modelId }: { modelId: string }) => modelId === 'e' ? executor : reviewer } },
    resilience: { retries: 0, baseDelayMs: 0 },
    env: {},
    transport: async () => new Response(JSON.stringify({ value: 'ok' }), { headers: { 'content-type': 'application/json' } }),
  });
  if (!outcome.result) throw new Error(`构造运行失败：${outcome.error}`);
  return { project, runId: outcome.result.manifest.runId, result: outcome.result };
}
