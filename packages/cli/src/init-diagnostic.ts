import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { builtinFactories } from '@crosscheck/models';
import type { CommandDependencies } from './context';

const LIMIT = 256 * 1024;

/** 限制读取量；过大或非文本内容不记录前缀，避免在脱敏前截断敏感值。 */
async function readBounded(stream: ReadableStream<Uint8Array> | null): Promise<{ text?: string; truncated?: boolean }> {
  if (!stream) return {};
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > LIMIT) { void reader.cancel().catch(() => {}); return { truncated: true }; }
      chunks.push(next.value);
    }
    return { text: Buffer.concat(chunks).toString('utf8') };
  } finally { reader.releaseLock(); }
}

export function initDiagnosticDependencies(deps: CommandDependencies, clean: (text: string, contentType: string) => unknown, log: (line: string) => void): CommandDependencies {
  const sessionId = deps.usageContext?.sessionId ?? null;
  const file = path.join(deps.userConfigHome ?? homedir(), '.crosscheck', 'init-diagnostics', `${randomUUID()}.jsonl`);
  const originalFactories = deps.modelOptions?.factories;
  let warned = false;
  const warn = () => { if (!warned) { warned = true; try { (deps.usageContext?.warn ?? log)('init 正文诊断记录失败'); } catch { /* 诊断失败不得影响主流程。 */ } } };
  const capture = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let request: Request | undefined;
    let requestBody: { text?: string; truncated?: boolean } = {};
    try {
      request = new Request(input, init);
      requestBody = await readBounded(request.clone().body);
    } catch { warn(); }
    let response: Response;
    try { response = await globalThis.fetch(input, init); }
    catch (error) {
      try { await write({ sessionId, request: requestBody.text === undefined ? undefined : clean(requestBody.text, request?.headers.get('content-type') ?? ''), requestTruncated: requestBody.truncated, networkError: true }); } catch { warn(); }
      throw error;
    }
    try {
      const body = await readBounded(response.clone().body);
      await write({ sessionId, statusCode: response.status, request: requestBody.text === undefined ? undefined : clean(requestBody.text, request?.headers.get('content-type') ?? ''), requestTruncated: requestBody.truncated, response: body.text === undefined ? undefined : clean(body.text, response.headers.get('content-type') ?? ''), responseTruncated: body.truncated });
    } catch { warn(); }
    return response;
  };
  async function write(record: object) {
    try { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await appendFile(file, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`, { mode: 0o600 }); }
    catch { warn(); }
  }
  return { ...deps, modelOptions: { ...deps.modelOptions, factories: {
    openai: settings => (originalFactories?.openai ?? builtinFactories.openai)({ ...settings, fetch: capture }),
    anthropic: settings => (originalFactories?.anthropic ?? builtinFactories.anthropic)({ ...settings, fetch: capture }),
  } } };
}
