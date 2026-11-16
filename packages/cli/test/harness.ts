// 只构建为测试专用入口；生产入口不读取这些环境变量或 IPC 控制。
import { MockLanguageModelV4 } from 'ai/test';
import { scriptedModel } from '../../agent/src/testing/scripted-model';
import { cliMain } from '../src/main';
const controller = new AbortController();
process.on('message', message => {
  if (message === 'abort') controller.abort();
  if (message === 'SIGINT' || message === 'SIGTERM') process.emit(message);
});
const mode = process.env.CROSSCHECK_TEST_MODE ?? 'pass';
const base = process.env.CROSSCHECK_TEST_BASE!;
const evidenceIds = (prompt: unknown) => [...new Set([...JSON.stringify(prompt).matchAll(/e-[a-f0-9-]{36}/g)].map(match => match[0]!))];
const finish = (verdict: string, ids: string[], reasoning: string) => ({ toolCalls: [{ name: 'finish', input: { judgements: ['E1', 'E2'].map(expectationId => ({ expectationId, verdict, evidenceIds: ids, reasoning })) } }] });
let step = 0;
const executor = new MockLanguageModelV4({ doGenerate: async opts => {
  if (mode === 'invalid') return scriptedModel([{ text: '不是有效结构' }]).doGenerate(opts);
  if (mode === 'hang' || mode === 'second-hang' && step >= 3) {
    process.send?.('model-waiting');
    return scriptedModel([{ hang: true }]).doGenerate(opts);
  }
  const ids = evidenceIds(opts.prompt);
  const call = step++ % 3;
  return scriptedModel([call < 2 ? { toolCalls: [{ name: 'http_request', input: { url: `${base}${call === 0 ? mode === 'redirect' ? '/redirect-out' : '/api/action' : '/item'}`, method: call === 0 && mode !== 'redirect' ? 'POST' : 'GET' } }] } : finish(mode === 'fail' ? 'fail' : 'pass', ids, 'EXECUTOR_ONLY_SENTINEL_1001')]).doGenerate(opts);
} });
const reviewer = new MockLanguageModelV4({ doGenerate: async opts => {
  const serialized = JSON.stringify(opts);
  if (serialized.includes('EXECUTOR_ONLY_SENTINEL_1001')) throw new Error('盲审隔离失败');
  return scriptedModel([finish(mode === 'disputed' ? 'fail' : mode === 'fail' ? 'fail' : mode === 'invalid' ? 'unclear' : 'pass', evidenceIds(opts.prompt), '独立观察')]).doGenerate(opts);
} });
process.exitCode = await cliMain(process.argv.slice(2), { signal: controller.signal, dependencies: { resilience: { retries: 0, baseDelayMs: 0 }, modelOptions: { factories: { ollama: ({ modelId }) => modelId === 'executor' ? executor : reviewer } } } });
if (process.connected) process.disconnect?.();
