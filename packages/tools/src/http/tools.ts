import { defineTool } from '@crosscheck/agent';
import { z } from 'zod';
import { HttpOperationError, type EvidenceMeta, type HttpRequest, type HttpResult } from '../network/http-client';

/** 模型入口只接受有限业务头；身份由宿主封装的 client 注入。 */
export class HttpTools {
  constructor(private readonly client: { request(input: HttpRequest, meta: EvidenceMeta): Promise<HttpResult> }) {}
  async request(input: HttpRequest, meta: EvidenceMeta): Promise<HttpResult> {
    const safeHeaders = new Set(['accept', 'content-type']);
    if ((input.headers ?? []).some(([name]) => !safeHeaders.has(name.toLowerCase().trim()))) throw new Error('模型不能提供此请求头');
    const sensitive = (name: string) => /password|passwd|pwd|token|secret|apikey|session|^sid$|authorization|cookie/i.test(name.replace(/[-_\s]/g, ''));
    let url: URL;
    try { url = new URL(input.url); } catch { throw new Error('地址不合法'); }
    if ([...url.searchParams.keys()].some(sensitive)) throw new Error('模型不能提供敏感查询字段');
    if (input.body !== undefined) {
      if (typeof input.body !== 'string') throw new Error('无法验证模型正文');
      const type = (input.headers ?? []).find(([name]) => name.toLowerCase() === 'content-type')?.[1].split(';')[0]?.trim().toLowerCase();
      if (type === 'application/json') {
        let value: unknown;
        try { value = JSON.parse(input.body); } catch { throw new Error('无法验证模型正文'); }
        const contains = (v: unknown): boolean => !!v && typeof v === 'object' && Object.entries(v).some(([k, x]) => sensitive(k) || contains(x));
        if (contains(value)) throw new Error('模型不能提供敏感正文字段');
      } else if (type === 'application/x-www-form-urlencoded') {
        if ([...new URLSearchParams(input.body).keys()].some(sensitive)) throw new Error('模型不能提供敏感正文字段');
      } else throw new Error('无法验证模型正文');
    }
    return this.client.request(input, meta);
  }
}

export interface HttpClientFacade {
  request(input: HttpRequest, meta: EvidenceMeta): Promise<HttpResult>;
  recordBlocked(meta: EvidenceMeta): Promise<string[]>;
}

export function createHttpTools(client: HttpClientFacade, nextMeta: () => EvidenceMeta) {
  const tools = new HttpTools(client);
  return [defineTool({
    name: 'http_request', category: 'http', description: '发送符合网络策略的 HTTP 请求',
    input: z.strictObject({ url: z.string(), method: z.string().optional(), headers: z.array(z.tuple([z.string(), z.string()])).optional(), body: z.string().optional() }),
    async execute(input, ctx) {
      const meta = nextMeta();
      try { return await tools.request({ ...input, signal: ctx.signal }, meta); }
      catch (error) {
        if (error instanceof HttpOperationError) return { error: { kind: error.kind, message: error.message }, evidenceIds: error.evidenceIds };
        if (error instanceof Error && ['模型不能提供此请求头', '模型不能提供敏感查询字段', '模型不能提供敏感正文字段', '无法验证模型正文', '地址不合法'].includes(error.message)) return { error: { kind: 'blocked', message: '请求未通过验证' }, evidenceIds: await client.recordBlocked(meta) };
        throw error;
      }
    },
  })];
}
