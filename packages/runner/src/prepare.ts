import { z } from 'zod';
import { runAgent, type AgentResult, type RunAgentOptions } from '@crosscheck/agent';
import type { FixtureHost, AuthenticationHost, EvidenceMeta, AuthSession, EvidenceStore } from '@crosscheck/tools';
import type { TestCase, Actor, EvidenceRecord } from '@crosscheck/core';

const PreparationSchema = z.strictObject({ prepared: z.boolean(), evidenceIds: z.array(z.string().min(1)) });
type PreparationOutput = z.infer<typeof PreparationSchema>;

export class PreparationBlocked extends Error {}
/** known fixture 失败直接传播；仅 missing 普通夹具可现场 HTTP 造数。 */
export async function prepareCase(options: {
  tc: TestCase; actor: Actor; fixtures: FixtureHost; auth: AuthenticationHost; nextMeta: () => EvidenceMeta; signal: AbortSignal;
  store: EvidenceStore; records: () => Promise<EvidenceRecord[]>;
  fallback: Omit<RunAgentOptions<PreparationOutput>, 'stage' | 'output' | 'outputSchema' | 'validateOutput'>;
  onFallback: (result: AgentResult<PreparationOutput>) => void;
  onMissing: (names: string[]) => void;
  check: () => void;
}): Promise<{ session: AuthSession; variables: unknown }> {
  const prepared = await options.fixtures.prepare(options.tc.fixtures, options.tc.actor, options.nextMeta, options.signal);
  if (prepared.status === 'missing') {
    options.onMissing(prepared.missing);
    const before = new Set((await options.records()).map(record => record.id));
    const result = await runAgent({ ...options.fallback, stage: 'prepare', output: PreparationSchema,
      validateOutput: async value => {
        if (!value.prepared || !value.evidenceIds.length || new Set(value.evidenceIds).size !== value.evidenceIds.length) return { ok: false, error: '准备完成必须引用本次现场准备窗口的真实HTTP观察凭据' };
        const records = await options.records();
        for (const id of value.evidenceIds) {
          const record = records.find(record => record.id === id);
          if (!record || before.has(id) || record.phase !== 'preparation' || record.type !== 'network') return { ok: false, error: '凭据不属于本次现场准备HTTP窗口' };
          // verify严格保持本attempt归属/hash校验；只解释生产HAR信封，不猜业务正文。
          const har = JSON.parse((await options.store.verify(record)).toString('utf8'));
          const entries = har?.log?.entries;
          const source = await options.store.readTextEvidence(id);
          if (source.sourceIncomplete || !Array.isArray(entries) || !entries.length || entries.some((entry: any) => entry.failure || !Number.isInteger(entry.response?.status) || entry.response.status < 200 || entry.response.status >= 300)) return { ok: false, error: '准备凭据必须为完整且成功的真实HTTP观察' };
        }
        return { ok: true };
      } });
    options.onFallback(result);
    if (result.status !== 'done' || !result.output.prepared) throw new PreparationBlocked(result.status === 'blocked' ? result.detail : '缺失夹具现场造数未完成');
  }
  options.check();
  const session = prepared.session ?? await options.auth.authenticate(options.actor, options.nextMeta(), options.signal);
  return { session, variables: Object.fromEntries(Object.entries(prepared.fixtures).map(([name, result]) => [name, result.variables])) };
}
