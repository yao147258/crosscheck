import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, GuardrailsSchema } from '../../core/src/index';
import { createEvidenceRedactor } from '../src/evidence/redactor';
import { EvidenceStore } from '../src/evidence/store';
import { HttpClient } from '../src/network/http-client';
import { RequestPolicy } from '../src/network/policy';
import { createHttpTools } from '../src/http/tools';
import { ApprovedCommandRunner } from '../src/command/runner';
import { AuthenticationHost } from '../src/auth/host';

const roots:string[]=[];
const meta={actionId:'a-auth',phase:'preparation' as const};
const signal=()=>new AbortController().signal;
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(env:Record<string,string>={}) {
 const root=await mkdtemp(path.join(tmpdir(),'auth7-'));roots.push(root);
 const artifacts=new ArtifactStore(root),redactor=createEvidenceRedactor();
 const store=new EvidenceStore(artifacts,{runId:'run-7',caseId:'M-TC-1',attempt:1},redactor);
 const requests:{url:string;headers:Headers}[]=[];
 const client=new HttpClient(new RequestPolicy(GuardrailsSchema.parse({allowedHosts:['target.test','other.test']})),store,redactor,{transport:async(url,init)=>{requests.push({url,headers:new Headers(init.headers)}); if(url.endsWith('/redirect'))return new Response(null,{status:302,headers:{location:'https://other.test/final'}}); return new Response('{"echo":"dynamic-secret","id":9}',{headers:{'content-type':'application/json'}});}});
 const commands=new ApprovedCommandRunner(artifacts,'run-7',redactor,{env});
 const host=new AuthenticationHost('https://target.test/base',client,commands,store,redactor,{env});
 return {host,store,redactor,requests};
}
it.each([
 {kind:'form',environment:'dev',actions:[{kind:'click',selector:'button'}]},
 {kind:'replay',environment:'dev',actions:[{kind:'click',selector:'button'}]},
 {kind:'token',env:'TOKEN',inject:{kind:'storage',storage:'local',name:'token'}},
])('未注入浏览器适配器的身份明确拒绝且零网络 %j',async actor=>{
 const {host,requests}=await setup({TOKEN:'dynamic-secret'});
 await expect(host.authenticate(actor as any,meta,signal())).rejects.toMatchObject({kind:'blocked',message:expect.stringContaining('浏览器认证适配器')});
 expect(requests).toEqual([]);
});
it.each([
 [{kind:'token',env:'TOKEN',inject:{kind:'header',name:'X-Custom'}},'x-custom','dynamic-secret'],
 [{kind:'token',env:'TOKEN',inject:{kind:'cookie',name:'sid'}},'cookie','sid=dynamic-secret'],
])('token 只注入初始同源请求，外站白名单和跳转仍不携身份 %j',async(actor,header,value)=>{
 const {host,requests}=await setup({TOKEN:'dynamic-secret'});
 const session=await host.authenticate(actor as any,meta,signal());
 await session.client.request({url:'https://target.test/ok'},meta);
 await session.client.request({url:'https://other.test/ok'},meta);
 await session.client.request({url:'https://target.test/redirect'},meta);
 expect(requests.map(r=>r.headers.get(header as string))).toEqual([value,null,value,null]);
 expect(JSON.stringify(session)).not.toContain('dynamic-secret');
});
it('command 身份先登记动态秘密再采证，原 stdout 不进入模型结果，blocked 委托可用',async()=>{
 const {host,store,redactor,requests}=await setup();
 const session=await host.authenticate({kind:'command',command:{program:process.execPath,argv:['-e','console.log(JSON.stringify({headers:{"X-Custom":"dynamic-secret",Cookie:"sid=dynamic-secret"}}))'],env:{}}},meta,signal());
 expect(redactor.text('dynamic-secret')).toBe('[REDACTED]');
 const result=await session.client.request({url:'https://target.test/ok'},meta);
 const response=await store.readHttpResponse(result.evidenceIds[0]!);
 expect(response.body).toEqual({echo:'[REDACTED]',id:9});
 const [tool]=createHttpTools(session.client,()=>meta);
 const blocked=await tool!.execute({url:'https://target.test/?token=raw-value'},{signal:signal()}) as any;
 expect(blocked.error.kind).toBe('blocked');expect(blocked.evidenceIds).toHaveLength(1);
 expect(requests).toHaveLength(1);
 expect(JSON.stringify(session)).not.toContain('dynamic-secret');
});
it.each([{Cookie:'sid=dynamic-secret; csrf=other-secret'},{Authorization:'Bearer dynamic-secret'}])('command cookie/Bearer 凭证分量被反射时仍脱敏 %j',async headers=>{
 const {host,store,redactor}=await setup();
 const session=await host.authenticate({kind:'command',command:{program:process.execPath,argv:['-e',`console.log(${JSON.stringify(JSON.stringify({headers}))})`],env:{}}},meta,signal());
 expect(redactor.text('dynamic-secret')).toBe('[REDACTED]');
 const response=await session.client.request({url:'https://target.test/ok'},meta);
 expect((await store.readHttpResponse(response.evidenceIds[0]!)).body).toEqual({echo:'[REDACTED]',id:9});
});
it('认证命令的宿主磁盘/进程清理异常不能伪装认证失败',async()=>{
 const {host}=await setup();
 const failure=new Error('host-storage-failure');
 // 只替换可信命令适配边界，验证上层不吞宿主异常。
 const commands=(host as any).commands;commands.run=async()=>{throw failure;};
 await expect(host.authenticate({kind:'command',command:{program:process.execPath,argv:[],env:{}}},meta,signal())).rejects.toBe(failure);
});
it.each(['{"headers":{"X-Key":7}}','{"headers":{"Host":"evil"}}','{"headers":{"X-Key":"a\\r\\nb"}}','{"headers":{},"extra":true}'])('无效 command header 输出不派发网络 %s',async output=>{
 const {host,requests}=await setup();
 await expect(host.authenticate({kind:'command',command:{program:process.execPath,argv:['-e',`process.stdout.write(${JSON.stringify(output)})`],env:{}}},meta,signal())).rejects.toMatchObject({kind:'blocked'});
 expect(requests).toHaveLength(0);
});
it('auth 成功证据落盘中取消不发布身份，保留真实成功证据及 ID',async()=>{
 const {host,store,requests}=await setup();
 const controller=new AbortController(),save=store.saveText.bind(store);let completed:Awaited<ReturnType<typeof save>>|undefined;
 store.saveText=async(type,text,m)=>{
  if(JSON.parse(text).status==='success')await new Promise<void>(resolve=>setImmediate(()=>{controller.abort();resolve();}));
  const record=await save(type,text,m);if(JSON.parse(text).status==='success')completed=record;return record;
 };
 const failure=await host.authenticate({kind:'anonymous'},meta,controller.signal).catch(error=>error);
 expect(failure).toMatchObject({kind:'cancelled'});expect(failure).not.toHaveProperty('client');
 expect(completed).toBeDefined();expect(failure.evidenceIds).toContain(completed!.id);
 expect(JSON.parse((await store.verify(completed!)).toString())).toMatchObject({kind:'auth',status:'success'});
 expect(requests).toEqual([]);
});
it('auth 落盘期间取消也不能吞磁盘异常',async()=>{
 const {host,store}=await setup();const controller=new AbortController(),disk=new Error('disk-write-failed');
 store.saveText=async()=>{controller.abort();throw disk;};
 await expect(host.authenticate({kind:'anonymous'},meta,controller.signal)).rejects.toBe(disk);
});
it('anonymous 无认证头；token 缺失不降级',async()=>{
 const {host,requests}=await setup();
 const session=await host.authenticate({kind:'anonymous'},meta,signal());
 await session.client.request({url:'https://target.test/ok'},meta);
 expect([...requests[0]!.headers]).toEqual([]);
 await expect(host.authenticate({kind:'token',env:'ABSENT',inject:{kind:'header',name:'X-Token'}},meta,signal())).rejects.toMatchObject({kind:'blocked'});
});
