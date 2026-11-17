import { ArtifactError, ProfileSchema, ProfileNameSchema, type Profile, type Fixture } from '@crosscheck/core';
import type { ApprovedCommandRunner } from '../command/runner';
import { CommandOperationError } from '../command/runner';
import { AuthenticationError, type AuthenticationHost, type AuthSession } from '../auth/host';
import { HttpResponseUnavailableError, type EvidenceStore } from '../evidence/store';
import type { EvidenceRedactor } from '../evidence/redactor';
import type { HttpClientFacade } from '../http/tools';
import { HttpOperationError, type EvidenceMeta } from '../network/http-client';
import { executeFixtureSql, FixtureSqlError, type FixtureSqlOptions } from './sql';
import { FIXTURE_NOTICE } from './schema';

export interface FixtureResult {status:'success'|'missing';variables:unknown;evidenceIds:string[];notice:string}
export class FixtureOperationError extends Error {
  constructor(readonly kind:'blocked'|'cancelled'|'timeout'|'limit',readonly evidenceIds:string[]) {super(kind==='cancelled'?'夹具已取消':kind==='timeout'?'夹具超时':'批准夹具未完成，禁止缺失 fallback');}
}
export interface FixtureHostOptions extends Omit<FixtureSqlOptions,'env'> {
 client:HttpClientFacade;commands:ApprovedCommandRunner;auth:AuthenticationHost;store:EvidenceStore;redactor:EvidenceRedactor;env?:Record<string,string|undefined>;
}
export interface PreparationResult {status:'success'|'missing';missing:string[];fixtures:Record<string,FixtureResult>;evidenceIds:string[];session?:AuthSession}
/** 一个宿主实例绑定一个 case attempt 和环境；不可跨用例共享或恢复身份。 */
export class FixtureHost {
 private readonly profile:Profile;
 private readonly reset:string|null;
 private resetTask?:Promise<FixtureResult|undefined>;
 private queue:Promise<unknown>=Promise.resolve();
 constructor(profile:Profile,private readonly environment:string,private readonly options:FixtureHostOptions) {
  this.profile=ProfileSchema.parse(profile);
  if(!Object.hasOwn(this.profile['environments.yaml'].environments,environment))throw new Error('选中环境不存在');
  this.reset=this.profile['environments.yaml'].environments[environment]!.reset;
  if(options.sqlTimeoutMs!==undefined&&(!Number.isSafeInteger(options.sqlTimeoutMs)||options.sqlTimeoutMs<1||options.sqlTimeoutMs>15000))throw new Error('准备 SQL 截止不合法');
 }
 private enqueue<T>(work:()=>Promise<T>):Promise<T>{const result=this.queue.then(work);this.queue=result.then(()=>{},()=>{});return result;}
 private async fail(kind:FixtureOperationError['kind'],meta:EvidenceMeta,ids:string[]=[],sent?:false):Promise<never>{
  const record=await this.options.store.saveText('console',JSON.stringify({kind:'fixture',status:kind,...(sent===false?{sent:false}:{}),notice:FIXTURE_NOTICE}),meta);
  throw new FixtureOperationError(kind,[...ids,record.id]);
 }
 private async ensureReset(meta:EvidenceMeta,signal:AbortSignal):Promise<FixtureResult|undefined>{
  if(signal.aborted)return this.fail('cancelled',meta);
  this.resetTask??=this.reset===null?Promise.resolve(undefined):this.run(this.reset,meta,signal,true);
  return this.resetTask;
 }
 private async run(name:string,meta:EvidenceMeta,signal:AbortSignal,required=false):Promise<FixtureResult>{
  const {store,redactor}=this.options;
  if(meta.phase!=='preparation')return this.fail('blocked',meta);
  if(signal.aborted)return this.fail('cancelled',meta);
  if(!ProfileNameSchema.safeParse(name).success)return this.fail('blocked',meta);
  const fixtures=this.profile['fixtures.yaml'].fixtures;
  if(!Object.hasOwn(fixtures,name)) {
   if(required)return this.fail('blocked',meta);
   return {status:'missing',variables:null,evidenceIds:[],notice:'普通夹具缺失，由 runner 决定是否 prepare 现场造数；尚未准备成功'};
  }
  const fixture=fixtures[name]!;
  let variables:unknown;let ids:string[]=[];
  try {
   if(fixture.kind==='command')variables=redactor.value(await this.options.commands.run(fixture.command,signal));
   else if(fixture.kind==='sql')variables=await executeFixtureSql(fixture,this.profile,redactor,signal,{...this.options,env:this.options.env??process.env});
   else {
    const op=this.profile['api-catalog.yaml'].operations[fixture.operation]!;
    // 准备先于认证；声明依赖 actor 的操作不得偷偷用匿名身份或提前认证。
    if(op.environment!==this.environment||op.actor)throw new FixtureSqlError('blocked');
    const base=this.profile['environments.yaml'].environments[this.environment]!.baseURL;
    let url:string;
    try { url=new URL(op.path,base).href; }
    catch { return this.fail('blocked',meta,[],false); }
    const result=await this.options.client.request({url,method:op.method,...(fixture.body!==undefined?{headers:[['content-type','application/json']] as [string,string][],body:JSON.stringify(fixture.body)}:{}),signal},meta);
    ids=result.evidenceIds;
    if(result.summary.status<200||result.summary.status>=300||!ids.length)throw new FixtureSqlError('blocked');
    const response=await store.readHttpResponse(ids.at(-1)!);
    if(response.status!==result.summary.status)throw new ArtifactError('HTTP 响应证据状态不匹配');
    variables=response.body;
   }
  }catch(error){
   if(!(error instanceof CommandOperationError||error instanceof FixtureSqlError||error instanceof HttpOperationError||error instanceof HttpResponseUnavailableError))throw error;
   if(error instanceof HttpOperationError)ids=error.evidenceIds;
   const kind=signal.aborted?'cancelled':error instanceof CommandOperationError||error instanceof FixtureSqlError?error.kind:error instanceof HttpOperationError&&error.kind==='cancelled'?'cancelled':'blocked';
   return this.fail(kind,meta,ids);
  }
  if(signal.aborted)return this.fail('cancelled',meta,ids);
  // 不保存命令原 stdout/stderr、SQL、连接串或固定参数；结构化输出先脱敏。
  const payload={kind:'fixture',adapter:fixture.kind,status:'success',...(fixture.kind==='command'?{exitCode:0}:{}),variables:redactor.value(variables),notice:FIXTURE_NOTICE};
  const record=await store.saveText('console',JSON.stringify(payload),meta);
  // 业务已完成的证据不可撤销；取消仅阻止继续发布成功，不回滚或重试业务动作。
  if(signal.aborted)return this.fail('cancelled',meta,[...ids,record.id]);
  return {status:'success',variables:payload.variables,evidenceIds:[...ids,record.id],notice:FIXTURE_NOTICE};
 }
 execute(name:string,meta:EvidenceMeta,signal:AbortSignal):Promise<FixtureResult>{
  return this.enqueue(async()=>{
   if(meta.phase!=='preparation')return this.fail('blocked',meta);
   const reset=await this.ensureReset(meta,signal);
   return name===this.reset?reset!:this.run(name,meta,signal);
  });
 }
 /** 宿主顺序接口：known 失败优先于 missing；missing 时不认证，交 runner 决定后续。 */
 prepare(names:string[],actorName:string,nextMeta:()=>EvidenceMeta,signal:AbortSignal):Promise<PreparationResult>{
  return this.enqueue(async()=>{
   const firstMeta=nextMeta();
   if(firstMeta.phase!=='preparation')return this.fail('blocked',firstMeta);
   const actor=Object.hasOwn(this.profile['auth.yaml'].actors,actorName)?this.profile['auth.yaml'].actors[actorName]:undefined;
   if(!actor)return this.fail('blocked',firstMeta);
   const reset=await this.ensureReset(firstMeta,signal);
   const fixtures:Record<string,FixtureResult>=Object.create(null),missing:string[]=[],ids=[...(reset?.evidenceIds??[])];
   if(reset&&this.reset)fixtures[this.reset]=reset;
   for(const name of names){
    if(name===this.reset||Object.hasOwn(fixtures,name))continue;
    const result=await this.run(name,nextMeta(),signal);
    fixtures[name]=result;ids.push(...result.evidenceIds);
    if(result.status==='missing')missing.push(name);
   }
   if(missing.length)return {status:'missing',missing,fixtures,evidenceIds:ids};
   let session:AuthSession;
   try { session=await this.options.auth.authenticate(actor,nextMeta(),signal); }
   catch(error){
    if(error instanceof AuthenticationError)throw new AuthenticationError(error.kind,error.message,[...ids,...error.evidenceIds]);
    throw error;
   }
   if(signal.aborted)throw new AuthenticationError('cancelled','准备认证已取消',[...ids,...session.evidenceIds]);
   return {status:'success',missing,fixtures,evidenceIds:[...ids,...session.evidenceIds],session};
  });
 }
}
