import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore, ProfileSchema, type Profile } from '../../core/src/index';
import { grantTools } from '../../agent/src/grants';
import { createEvidenceRedactor } from '../src/evidence/redactor';
import { EvidenceStore } from '../src/evidence/store';
import { HttpClient } from '../src/network/http-client';
import { RequestPolicy } from '../src/network/policy';
import { ApprovedCommandRunner } from '../src/command/runner';
import { AuthenticationHost } from '../src/auth/host';
import type { PgConnection } from '../src/db/postgres';
import { FixtureHost } from '../src/fixtures/host';
import { createFixtureTools } from '../src/fixtures/tools';
import { createProfileTools } from '../src/profile/tools';

const roots:string[]=[];
const signal=()=>new AbortController().signal;
const meta={actionId:'a-fix',phase:'preparation' as const};
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function profile():Profile {return ProfileSchema.parse({
 'environments.yaml':{version:1,environments:{dev:{baseURL:'https://app.test',healthcheck:'https://app.test/health',reset:'reset'}}},
 'auth.yaml':{version:1,actors:{guest:{kind:'anonymous'},user:{kind:'token',env:'TOKEN',inject:{kind:'header',name:'X-Key'}}}},
 'api-catalog.yaml':{version:1,operations:{resetOp:{environment:'dev',method:'POST',path:'/reset',description:'重置数据',sources:[{file:'approved.md',line:1,excerpt:'已确认操作'}]},seedOp:{environment:'dev',method:'POST',path:'/seed',description:'创建订单',knowledge:['仅说明操作，不代表预期结果'],sources:[{file:'approved.md',line:1,excerpt:'已确认操作'}]}}},
 'pages.yaml':{version:1,pages:{}},
 'data-model.yaml':{version:1,connection:{kind:'postgres',env:'READ_DB'},queries:{seedSql:{sql:'INSERT INTO orders(data) VALUES ($1) RETURNING id',parameters:[{name:'data',type:'json'}]}}},
 'fixtures.yaml':{version:1,fixtures:{reset:{kind:'http',operation:'resetOp'},seed:{kind:'http',operation:'seedOp',body:{name:'order'}},sql:{kind:'sql',query:'seedSql',params:[['123',true]],connection:{kind:'postgres',env:'WRITE_DB'}},command:{kind:'command',command:{program:process.execPath,argv:['-e','console.log(JSON.stringify({id:12,password:"not-for-model"}))'],env:{}}}}},
 'guardrails.yaml':{allowedHosts:['app.test']},
});}
class FakePg implements PgConnection {
 calls:{text:string;values:unknown[]}[]=[];closed=false;hang=false;identity='writer';fail=false;pending?:()=>void;
 async connect(){}
 async run(text:string,values:unknown[],row:(r:Record<string,unknown>)=>void){this.calls.push({text,values});if(text.includes('current_user')){row({current_user:this.identity,session_user:this.identity});return;}if(text.startsWith('INSERT')){if(this.fail)throw new Error('raw-db-secret');if(this.hang)await new Promise<void>((_,reject)=>{this.pending=()=>reject(new Error('closed'));});row({id:55,password:'db-unknown-secret'});}}
 async close(){this.closed=true;this.pending?.();}
}
async function setup(p=profile(), extra:{env?:Record<string,string>;maxMs?:number}={}) {
 const root=await mkdtemp(path.join(tmpdir(),'fixture7-'));roots.push(root);
 const artifacts=new ArtifactStore(root),redactor=createEvidenceRedactor();
 const store=new EvidenceStore(artifacts,{runId:'run-7',caseId:'M-TC-1',attempt:1},redactor);
 const events:string[]=[];let httpStatus=201;let responseBody='{"id":42,"password":"unknown-password"}';
 const client=new HttpClient(new RequestPolicy(p['guardrails.yaml']),store,redactor,{transport:async(url)=>{events.push(new URL(url).pathname);return new Response(responseBody,{status:httpStatus,headers:{'content-type':'application/json'}});}});
 const env={READ_DB:'postgres://reader:read-secret@localhost/db',WRITE_DB:'postgres://writer:write-secret@localhost/db',TOKEN:'token-secret',...extra.env};
 const commands=new ApprovedCommandRunner(artifacts,'run-7',redactor,{env});
 const auth=new AuthenticationHost('https://app.test',client,commands,store,redactor,{env});
 const original=auth.authenticate.bind(auth);auth.authenticate=async(...args)=>{events.push('auth');return original(...args);};
 const pg=new FakePg(),readPg=new FakePg();readPg.identity='reader';let connects=0;
 const host=new FixtureHost(p,'dev',{client,commands,auth,store,redactor,env,createConnection:(url)=>{connects++;return url===env.READ_DB?readPg:pg;},sqlTimeoutMs:extra.maxMs});
 const evidence=async(ids:string[])=>{const index=JSON.parse((await artifacts.readBytes('runs/run-7/cases/M-TC-1/attempts/1/evidence/index.json'))!.toString());return Promise.all(ids.map(async id=>{const record=index.find((r:any)=>r.id===id);return (await store.verify(record)).toString();}));};
 return {host,auth,pg,readPg,events,store,artifacts,redactor,evidence,connects:()=>connects,status:(s:number)=>{httpStatus=s;},body:(s:string)=>{responseBody=s;}};
}
it.each(['default','shared'])('API/page URL 先按 URL 语义清理 query/hash 再进入摘要 %s',async mode=>{
 const p=profile();
 p['api-catalog.yaml'].operations.seedOp!.path='/export?api_key=profile-api-secret&mode=safe#token=profile-api-fragment';
 p['pages.yaml'].pages.detail={environment:'dev',path:'/detail?password=profile-page-secret&tab=info#access_token=profile-page-fragment',description:'已确认详情页',knowledge:[],sources:[{file:'approved.md',line:1,excerpt:'已确认页面'}]};
 const [tool]=createProfileTools(p,{},mode==='shared'?createEvidenceRedactor():undefined);
 const api=await tool!.execute({type:'api',keyword:''},{signal:signal()});
 const page=await tool!.execute({type:'page',keyword:''},{signal:signal()});
 const output=JSON.stringify([api,page]);
 expect(output).not.toMatch(/profile-api-secret|profile-api-fragment|profile-page-secret|profile-page-fragment/);
 expect(output).toContain('/export');expect(output).toContain('mode=safe');expect(output).toContain('/detail');expect(output).toContain('tab=info');expect(output).toContain('%5BREDACTED%5D');
});
it('异步 row 事件中 2500 层合法 JSON 清洗异常受控失败、关闭两连接且不 COMMIT',async()=>{
 const p=profile();p['environments.yaml'].environments.dev!.reset=null;
 const {host,pg,readPg,evidence}=await setup(p);
 const deep=JSON.parse('['.repeat(2500)+'0'+']'.repeat(2500));
 expect(Buffer.byteLength(JSON.stringify(deep))).toBe(5001);
 const run=pg.run.bind(pg);let delivered=false;
 pg.run=async(text,values,row)=>{
  if(!text.startsWith('INSERT'))return run(text,values,row);
  pg.calls.push({text,values});
  await new Promise<void>(resolve=>setImmediate(()=>{
   delivered=true;
   // 刻意不 catch：必须由生产 row 回调保护真正的异步事件边界。
   try{row({data:deep});}finally{resolve();}
  }));
 };
 const failure=await host.execute('sql',meta,signal()).catch(error=>error);
 expect(delivered).toBe(true);expect(failure).toMatchObject({kind:'blocked'});
 expect(pg.closed).toBe(true);expect(readPg.closed).toBe(true);expect(pg.calls.some(call=>call.text==='COMMIT')).toBe(false);
 expect((await evidence(failure.evidenceIds)).join('')).not.toMatch(/RangeError|Maximum call stack|\[\[\[\[/);
});
it('HTTP fixture URL 配置解析错误零网络，固定 blocked 和未发送证据',async()=>{
 const p=profile();p['environments.yaml'].environments.dev!.reset=null;p['api-catalog.yaml'].operations.seedOp!.path='http://[';
 const {host,events,evidence}=await setup(p);
 const failure=await host.execute('seed',meta,signal()).catch(error=>error);
 expect(events).toEqual([]);expect(failure).toMatchObject({kind:'blocked',evidenceIds:expect.any(Array)});
 expect((await evidence(failure.evidenceIds)).map(text=>JSON.parse(text))).toEqual([expect.objectContaining({kind:'fixture',status:'blocked',sent:false})]);
 expect(failure.message).not.toMatch(/TypeError|Invalid URL|http:/);
});
it.each(['command','sql','seed'])('夹具完成证据落盘中取消保留真实完成记录与 ID，不返回 success 或重试 %s',async name=>{
 const p=profile();p['environments.yaml'].environments.dev!.reset=null;
 const {host,store,evidence,pg,events}=await setup(p);
 const controller=new AbortController(),save=store.saveText.bind(store);const completed:string[]=[];
 store.saveText=async(type,text,m)=>{
  const payload=JSON.parse(text);
  if(payload.kind==='fixture'&&payload.status==='success'){
   await new Promise<void>(resolve=>setImmediate(()=>{controller.abort();resolve();}));
   const record=await save(type,text,m);completed.push(record.id);return record;
  }
  return save(type,text,m);
 };
 const failure=await host.execute(name,meta,controller.signal).catch(error=>error);
 expect(failure).toMatchObject({kind:'cancelled'});expect(completed).toHaveLength(1);
 expect(failure.evidenceIds).toEqual(expect.arrayContaining(completed));
 expect((await evidence(completed)).map(text=>JSON.parse(text))).toEqual([expect.objectContaining({kind:'fixture',status:'success'})]);
 if(name==='sql')expect(pg.calls.filter(call=>call.text==='COMMIT')).toHaveLength(1);
 if(name==='seed')expect(events).toEqual(['/seed']);
});
it('prepare 的认证证据落盘中取消不发布 session，保留前置夹具完成证据',async()=>{
 const p=profile();p['environments.yaml'].environments.dev!.reset=null;
 const {host,store,evidence,events}=await setup(p);
 const controller=new AbortController(),save=store.saveText.bind(store);const completed:string[]=[];
 store.saveText=async(type,text,m)=>{
  const payload=JSON.parse(text);
  if(payload.kind==='auth'&&payload.status==='success')await new Promise<void>(resolve=>setImmediate(()=>{controller.abort();resolve();}));
  const record=await save(type,text,m);if(payload.status==='success')completed.push(record.id);return record;
 };
 const failure=await host.prepare(['seed'],'guest',()=>meta,controller.signal).catch(error=>error);
 expect(failure).toMatchObject({kind:'cancelled'});expect(failure).not.toHaveProperty('session');
 expect(failure.evidenceIds).toEqual(expect.arrayContaining(completed));
 expect(events).toEqual(['/seed','auth']);expect(completed).toHaveLength(2);
 expect((await evidence(completed)).map(text=>JSON.parse(text).status)).toEqual(['success','success']);
});
it('prepare 在认证 await 返回后再次检查取消，不发布刚取得的 session',async()=>{
 const p=profile();p['environments.yaml'].environments.dev!.reset=null;
 const {host,auth,evidence}=await setup(p);const controller=new AbortController(),authenticate=auth.authenticate.bind(auth);let authIds:string[]=[];
 auth.authenticate=async(...args)=>{const session=await authenticate(...args);authIds=session.evidenceIds;controller.abort();return session;};
 const failure=await host.prepare([],'guest',()=>meta,controller.signal).catch(error=>error);
 expect(failure).toMatchObject({kind:'cancelled'});expect(failure).not.toHaveProperty('session');expect(failure.evidenceIds).toEqual(expect.arrayContaining(authIds));
 expect((await evidence(authIds)).map(text=>JSON.parse(text).status)).toEqual(['success']);
});
it('fixture 完成证据落盘期间取消不吞磁盘异常',async()=>{
 const p=profile();p['environments.yaml'].environments.dev!.reset=null;
 const {host,store}=await setup(p);const controller=new AbortController(),disk=new Error('fixture-disk-failure');
 store.saveText=async()=>{controller.abort();throw disk;};
 await expect(host.execute('seed',meta,controller.signal)).rejects.toBe(disk);
});
it('宿主顺序 reset 恰一次→声明夹具→auth，并以真实响应证据返回变量',async()=>{
 const {host,events,evidence}=await setup();
 const result=await host.prepare(['reset','seed','reset'],'guest',()=>meta,signal());
 expect(result.status).toBe('success');expect(events).toEqual(['/reset','/seed','auth']);
 expect(result.fixtures.seed!.variables).toEqual({id:42,password:'[REDACTED]'});
 expect((await evidence(result.fixtures.seed!.evidenceIds)).join('')).toContain('42');
 await host.execute('reset',meta,signal());expect(events.filter(x=>x==='/reset')).toHaveLength(1);
});
it('缺普通夹具返回 missing，已知失败只 blocked 且不认证、不变成 missing',async()=>{
 const {host,events,status}=await setup();
 const missing=await host.prepare(['absent'],'guest',()=>meta,signal());
 expect(missing).toMatchObject({status:'missing',missing:['absent']});expect(events).toEqual(['/reset']);
 status(500);
 await expect(host.prepare(['absent','seed'],'guest',()=>meta,signal())).rejects.toMatchObject({kind:'blocked'});
 expect(events).toEqual(['/reset','/seed']);
});
it('失败 reset 被缓存，不重试也不执行其他夹具或 auth',async()=>{
 const {host,events,status}=await setup();status(500);
 for(let i=0;i<2;i++)await expect(host.prepare(['seed'],'guest',()=>meta,signal())).rejects.toMatchObject({kind:'blocked'});
 expect(events).toEqual(['/reset']);
});
it('reset:null 不造 reset；command 返回脱敏变量及完成凭证而不是业务断言',async()=>{
 const p=profile();p['environments.yaml'].environments.dev!.reset=null;
 const {host,evidence,events}=await setup(p);
 const result=await host.execute('command',meta,signal());
 expect(result).toMatchObject({status:'success',variables:{id:12,password:'[REDACTED]'},notice:expect.stringContaining('非预期')});
 const saved=(await evidence(result.evidenceIds)).join('');expect(saved).toContain('"exitCode":0');expect(saved).not.toContain('not-for-model');expect(events).toEqual([]);
});
it('SQL 夹具独立准备事务、固定 SQL/JSON 参数、提交后才产生完成证据',async()=>{
 const {host,pg,evidence}=await setup();const result=await host.execute('sql',meta,signal());
 expect(pg.calls.map(c=>c.text)).toEqual(['BEGIN',"SET LOCAL statement_timeout = '10000ms'","SET LOCAL lock_timeout = '2000ms'",'SELECT current_user, session_user','INSERT INTO orders(data) VALUES ($1) RETURNING id','COMMIT']);
 expect(pg.calls[4]!.values).toEqual(['["123",true]']);expect(pg.closed).toBe(true);
 expect(result.variables).toEqual([{id:55,password:'[REDACTED]'}]);expect((await evidence(result.evidenceIds)).join('')).not.toMatch(/write-secret|INSERT INTO|db-unknown-secret/);
});
it.each([
 {WRITE_DB:'postgresql://reader:other@localhost:5432/db?sslmode=disable'},
 {WRITE_DB:'postgres://reader:read-secret@localhost/db'},
 {WRITE_DB:'postgres://writer@localhost/db'},
])('静态拒绝同账号/实际相同连接/不完整 URL，零准备连接 %j',async env=>{
 const {host,connects}=await setup(profile(),{env});
 await expect(host.execute('sql',meta,signal())).rejects.toMatchObject({kind:'blocked'});expect(connects()).toBe(0);
});
it('准备连接实际 session/current 账号与只读账号复用时不执行写 SQL',async()=>{
 const {host,pg}=await setup();pg.identity='reader';
 await expect(host.execute('sql',meta,signal())).rejects.toMatchObject({kind:'blocked'});
 expect(pg.calls.some(c=>c.text.startsWith('INSERT'))).toBe(false);expect(pg.closed).toBe(true);
});
it('URL 不同用户名映射到相同实际账号也必须拒绝，两个专属连接都关闭',async()=>{
 const {host,pg,readPg}=await setup();readPg.identity='mapped-role';pg.identity='mapped-role';
 await expect(host.execute('sql',meta,signal())).rejects.toMatchObject({kind:'blocked'});
 expect(pg.calls.some(c=>c.text.startsWith('INSERT'))).toBe(false);expect(pg.closed).toBe(true);expect(readPg.closed).toBe(true);
});
it.each(['form','replay','storage'])('不支持的身份在 reset 前拒绝，准备流程零网络 %s',async kind=>{
 const p=profile();p['auth.yaml'].actors.guest=kind==='storage'?{kind:'token',env:'TOKEN',inject:{kind:'storage',storage:'local',name:'token'}}:{kind:kind as 'form'|'replay',environment:'dev',actions:[{kind:'click',selector:'button'}]};
 const {host,events}=await setup(p);
 await expect(host.prepare(['seed'],'guest',()=>meta,signal())).rejects.toMatchObject({kind:'blocked',message:expect.stringContaining('浏览器工具暂缓')});expect(events).toEqual([]);
});
it('HTTP 缺失/损坏完成证据和磁盘失败不能伪装夹具业务失败',async()=>{
 const {host,store}=await setup();
 store.readHttpResponse=async()=>{throw new (await import('../../core/src/index')).ArtifactError('证据损坏');};
 await expect(host.execute('seed',meta,signal())).rejects.toThrow('证据损坏');
});
it('HTTP 采证底层普通错误和 SQL 连接清理失败原样传播宿主，不冒充 blocked',async()=>{
 const first=await setup();const disk=new Error('disk-failure');first.store.saveHar=async()=>{throw disk;};
 await expect(first.host.execute('seed',meta,signal())).rejects.toBe(disk);
 const second=await setup();const cleanup=new Error('cleanup-failure');second.pg.close=async()=>{throw cleanup;};
 await expect(second.host.execute('sql',meta,signal())).rejects.toBe(cleanup);
});
it('SQL JSON nullable null 绑定 SQL NULL，普通标量保持原值',async()=>{
 const p=profile();p['data-model.yaml'].queries.seedSql!.parameters=[{name:'a',type:'json',nullable:true},{name:'b',type:'string',nullable:false}];p['fixtures.yaml'].fixtures.sql={kind:'sql',query:'seedSql',params:[null,'123'],connection:{kind:'postgres',env:'WRITE_DB'}};
 const {host,pg}=await setup(p);await host.execute('sql',meta,signal());expect(pg.calls.find(c=>c.text.startsWith('INSERT'))!.values).toEqual([null,'123']);
});
it('并发调用共享一次 reset；非 preparation meta 副作用前阻断',async()=>{
 const first=await setup();await Promise.all([first.host.execute('seed',meta,signal()),first.host.execute('seed',meta,signal())]);expect(first.events).toEqual(['/reset','/seed','/seed']);
 const second=await setup();await expect(second.host.execute('seed',{...meta,phase:'execution'},signal())).rejects.toMatchObject({kind:'blocked'});expect(second.events).toEqual([]);
});
it.each(['cancel','timeout','failure'])('SQL 取消/截止/错误关闭专属连接、禁止 COMMIT 并保存失败证据 %s',async mode=>{
 const {host,pg,evidence}=await setup(profile(),{maxMs:100});pg.hang=mode!=='failure';pg.fail=mode==='failure';
 const controller=new AbortController();const pending=host.execute('sql',meta,controller.signal).catch(e=>e);
 if(mode==='cancel'){for(let i=0;i<100&&!pg.pending;i++)await new Promise(r=>setTimeout(r,2));expect(pg.pending).toBeTypeOf('function');controller.abort();}
 const failure=await pending as any;expect(failure.kind).toBe(mode==='cancel'?'cancelled':mode==='timeout'?'timeout':'blocked');
 expect(pg.closed).toBe(true);expect(pg.calls.some(c=>c.text==='COMMIT')).toBe(false);
 expect((await evidence(failure.evidenceIds)).join('')).not.toContain('raw-db-secret');
});
it('HTTP 夹具不能访问其他环境操作或绕过 policy；已取消不发生 reset',async()=>{
 const p=profile();p['guardrails.yaml'].forbidden=[{kind:'http',method:'POST',path:'/seed'}] as any;
 const {host,events}=await setup(p);
 await expect(host.execute('seed',meta,signal())).rejects.toMatchObject({kind:'blocked'});expect(events).toEqual(['/reset']);
 const s=await setup();const controller=new AbortController();controller.abort();await expect(s.host.execute('seed',meta,controller.signal)).rejects.toMatchObject({kind:'cancelled'});expect(s.events).toEqual([]);
});
it('不可用响应变量是既有夹具 blocked，证据真正损坏仍为宿主错误',async()=>{
 const {host,body,events}=await setup();body('not-json');
 await expect(host.execute('seed',meta,signal())).rejects.toMatchObject({kind:'blocked',evidenceIds:expect.any(Array)});
 expect(events).toEqual(['/reset']);
});
it('fixture AgentTool 严格名称输入、宿主 meta/signal，execute 阶段不能授予',async()=>{
 const {host,events}=await setup();let calls=0;const tools=createFixtureTools(host,()=>{calls++;return meta;});
 expect(grantTools('execute',tools).granted).toHaveLength(0);expect(grantTools('prepare',tools).granted).toHaveLength(1);
 expect(tools[0]!.input.safeParse({name:'seed',sql:'DELETE',params:[]}).success).toBe(false);
 const controller=new AbortController();controller.abort();const result=await tools[0]!.execute({name:'seed'},{signal:controller.signal}) as any;
 expect(result.error.kind).toBe('cancelled');expect(result.evidenceIds).toHaveLength(1);expect(calls).toBe(1);expect(events).toEqual([]);
});
it('profile 仅从已确认内存检索有限操作知识，截断明确，无路径/SQL/命令/秘密配置',async()=>{
 const p=profile();p['api-catalog.yaml'].operations.seedOp!.description='订单'.repeat(1000);
 const [tool]=createProfileTools(p,{maxItems:1,maxSummaryChars:30});
 expect(tool!.input.safeParse({type:'api',keyword:'订单',path:'E:/source'}).success).toBe(false);
 const result=await tool!.execute({type:'api',keyword:'订单'},{signal:signal()}) as any;
 expect(result.items).toHaveLength(1);expect(result.items[0].truncated).toBe(true);expect(result.items[0].summary).toContain('已截断');expect(result.notice).toContain('非预期');
 const all=await tool!.execute({type:'all',keyword:''},{signal:signal()});expect(JSON.stringify(all)).not.toMatch(/read-secret|WRITE_DB|READ_DB|INSERT INTO|console.log|TOKEN/);
 expect(grantTools('plan',[tool!]).granted).toHaveLength(1);
 const controller=new AbortController();controller.abort();await expect(tool!.execute({type:'all',keyword:''},{signal:controller.signal})).resolves.toMatchObject({status:'cancelled'});
});
