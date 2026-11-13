import { describe, it, expect } from 'vitest';
import { HttpTools, createHttpTools } from '../src/http/tools';

describe('模型 HTTP 工具边界', () => {
  it('提供 AgentTool 且宿主决定元数据和取消信号', async () => {
    const signal = new AbortController().signal;
    let received: unknown;
    const [tool] = createHttpTools({ request: async (input, meta) => { received = { input, meta }; return { summary: { status:200, url:'http://localhost/' }, evidenceIds:['e-1'] }; }, recordBlocked: async () => ['e-blocked'] }, () => ({ actionId:'host-action', phase:'execution' }));
    expect(tool!.category).toBe('http');
    expect(tool!.input.safeParse({ url:'http://localhost/', phase:'cleanup' }).success).toBe(false);
    await tool!.execute({ url:'http://localhost/' }, { signal });
    expect(received).toEqual({ input:{url:'http://localhost/', signal}, meta:{actionId:'host-action', phase:'execution'} });
  });
  it('禁止模型提交认证头且不调用宿主客户端', async () => {
    let calls = 0;
    const tools = new HttpTools({ request: async () => { calls++; return { summary: { status: 200, url: 'http://localhost/' }, evidenceIds: ['e-1'] }; } });
    await expect(tools.request({ url: 'http://localhost/', headers: [['Authorization', 'secret']] }, { actionId:'a-1', phase:'execution' })).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it('拒绝模型在查询及结构化正文中传入敏感字段', async () => {
    let calls = 0;
    const tools = new HttpTools({ request: async () => { calls++; return { summary: { status: 200, url: 'http://localhost/' }, evidenceIds: [] }; } });
    await expect(tools.request({ url:'http://localhost/?token=secret' }, { actionId:'a-1', phase:'execution' })).rejects.toThrow();
    await expect(tools.request({ url:'http://localhost/', method:'POST', headers:[['content-type','application/json']], body:'{"password":"secret"}' }, { actionId:'a-1', phase:'execution' })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
