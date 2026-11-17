// 只构建为测试专用入口；生产入口不读取这些环境变量或 IPC 控制。
import { MockLanguageModelV4 } from 'ai/test';
import { createHash } from 'node:crypto';
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
// 在最终 provider 边界检查实际附件；只输出 ID/hash 收据，不读取宿主证据文件来替模型判断。
type Prompt = Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt'];
function browserEvidence(prompt: Prompt, role: 'executor' | 'reviewer') {
  const images: { id: string; digest: string }[] = [], domIds: string[] = [];
  let completeDom = false;
  for (const message of prompt) {
    if (message.role !== 'user') continue;
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const id = /^\[宿主证据 (e-[a-f0-9-]{36})\]/.exec(text)?.[1];
    if (!id) continue;
    if (text.includes('类型=dom')) { domIds.push(id); completeDom ||= text.includes('CLI_BROWSER_DONE'); }
    for (const part of message.content) {
      if (part.type !== 'file' || part.mediaType !== 'image/png') continue;
      if (part.data.type !== 'data' || !(part.data.data instanceof Uint8Array)) throw new Error('PNG 未以真实内存 bytes 交给 provider');
      const bytes = part.data.data;
      if (Buffer.from(bytes.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG 签名错误');
      images.push({ id, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
    }
  }
  if (JSON.stringify(prompt).includes(process.env.BROWSER_PASSWORD ?? '\u0000')) throw new Error('provider 收到凭证明文');
  if (!completeDom) throw new Error('provider 未收到真实成功页面 DOM');
  if (!(role === 'reviewer' && mode === 'browser-no-images') && images.length === 0) throw new Error('provider 未收到 PNG 附件');
  if (role === 'reviewer' && mode === 'browser-no-images' && images.length) throw new Error('无图候选收到图片');
  console.log(`BROWSER_RECEIPT ${JSON.stringify({ role, images, domIds, blind: !JSON.stringify(prompt).includes('EXECUTOR_ONLY_SENTINEL_1001') })}`);
  // 收据保留全部附件；判断仅引用最后一个 DOM 和截图，避免把旧的空白页当业务依据。
  return [domIds.at(-1)!, ...(images.length ? [images.at(-1)!.id] : [])];
}
let step = 0;
const executor = new MockLanguageModelV4({ doGenerate: async opts => {
  if (mode.startsWith('browser-')) {
    const actions = [
      { kind: 'navigate', url: '/' },
      { kind: 'fill', locator: { strategy: 'css', value: 'input[name=password]' }, env: 'BROWSER_PASSWORD' },
      { kind: 'click', locator: { strategy: 'role', value: 'button', name: '保存' } },
      { kind: 'observe', locator: { strategy: 'css', value: '#result' } },
    ];
    const action = actions[step++];
    return scriptedModel([action ? { toolCalls: [{ name: 'browser_action', input: action }] } : finish('pass', browserEvidence(opts.prompt, 'executor'), 'EXECUTOR_ONLY_SENTINEL_1001')]).doGenerate(opts);
  }
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
  if (mode.startsWith('browser-')) {
    if (opts.tools?.some(tool => !['finish', 'report_blocked'].includes(tool.name))) throw new Error('reviewer 获得业务工具');
    return scriptedModel([finish(mode === 'browser-disputed' ? 'fail' : 'pass', browserEvidence(opts.prompt, 'reviewer'), '独立观察真实 PNG 与成功 DOM')]).doGenerate(opts);
  }
  return scriptedModel([finish(mode === 'disputed' ? 'fail' : mode === 'fail' ? 'fail' : mode === 'invalid' ? 'unclear' : 'pass', evidenceIds(opts.prompt), '独立观察')]).doGenerate(opts);
} });
process.exitCode = await cliMain(process.argv.slice(2), { signal: controller.signal, dependencies: { resilience: { retries: 0, baseDelayMs: 0 }, modelOptions: { factories: { ollama: ({ modelId }) => modelId === 'executor' ? executor : reviewer } } } });
if (process.connected) process.disconnect?.();
