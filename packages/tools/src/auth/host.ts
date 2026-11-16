import { ActorSchema, HttpUrlSchema, type Actor } from '@crosscheck/core';
import type { ApprovedCommandRunner } from '../command/runner';
import { CommandOperationError } from '../command/runner';
import type { EvidenceStore } from '../evidence/store';
import type { EvidenceRedactor } from '../evidence/redactor';
import type { HttpClient, EvidenceMeta } from '../network/http-client';
import type { HttpClientFacade } from '../http/tools';
import { AuthHeadersSchema } from './schema';

class HostCommandFailure { constructor(readonly error:unknown) {} }

export class AuthenticationError extends Error {
  constructor(readonly kind:'blocked'|'cancelled', message:string, readonly evidenceIds:string[]) {super(message);}
}
export interface AuthSession { client:HttpClientFacade; evidenceIds:string[] }
/** 仅宿主持有 session；工具只能消费 client 的闭包，不能拿到凭证。 */
export class AuthenticationHost {
  private readonly origin:string;
  constructor(baseURL:string, private readonly client:Pick<HttpClient,'request'|'recordBlocked'>, private readonly commands:ApprovedCommandRunner, private readonly store:EvidenceStore, private readonly redactor:EvidenceRedactor, private readonly options:{env?:Record<string,string|undefined>}={}) {
    this.origin=new URL(HttpUrlSchema.parse(baseURL)).origin;
  }
  async authenticate(actor:Actor, meta:EvidenceMeta, signal:AbortSignal):Promise<AuthSession> {
    let headers:[string,string][]=[];
    let failure: {kind:'blocked'|'cancelled';message:string} | undefined;
    try {
      const parsed=ActorSchema.safeParse(actor);
      if(!parsed.success) throw new Error();
      actor=parsed.data;
      if(signal.aborted) { failure={kind:'cancelled',message:'认证已取消'}; throw new Error(); }
      if(actor.kind==='form'||actor.kind==='replay'||actor.kind==='token'&&actor.inject.kind==='storage') {
        failure={kind:'blocked',message:'浏览器工具暂缓，不支持该认证方式'};throw new Error();
      }
      let output:unknown={headers:{}};
      if(actor.kind==='token') {
        const source=this.options.env??process.env;
        const secret=Object.hasOwn(source,actor.env)?source[actor.env]:undefined;
        if(!secret) throw new Error();
        this.redactor.addSecrets([secret]);
        if(actor.inject.kind==='cookie') {
          if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(actor.inject.name)||! /^[\x21-\x7e]+$/.test(secret)||/[;",\\]/.test(secret)) throw new Error();
          output={headers:{Cookie:`${actor.inject.name}=${secret}`}};
        } else if(actor.inject.kind==='header') output={headers:{[actor.inject.name]:secret}};
      } else if(actor.kind==='command') {
        try { output=await this.commands.run(actor.command,signal); }
        catch(error) {
          if(!(error instanceof CommandOperationError))throw new HostCommandFailure(error);
          throw error;
        }
      }
      // 先收集动态输出中的字符串，再校验；无效输出也不会进入持久化日志。
      const collect=(v:unknown):void=>{if(typeof v==='string')this.redactor.addSecrets([v]);else if(v&&typeof v==='object')for(const x of Object.values(v))collect(x);};
      collect(output);
      const parsedHeaders=AuthHeadersSchema.safeParse(output);
      if(!parsedHeaders.success) throw new Error();
      headers=Object.entries(parsedHeaders.data.headers);
      for(const [name,value]of headers){
        if(name.toLowerCase()==='cookie')this.redactor.addSecrets(value.split(';').map(pair=>pair.slice(pair.indexOf('=')+1).trim()).filter(Boolean));
        if(name.toLowerCase()==='authorization'){
          const match=/^\S+\s+(.+)$/.exec(value);if(match)this.redactor.addSecrets([match[1]!]);
        }
      }
    } catch(error) {
      if(error instanceof HostCommandFailure)throw error.error;
      failure??={kind:signal.aborted||error instanceof CommandOperationError&&error.kind==='cancelled'?'cancelled':'blocked',message:signal.aborted?'认证已取消':'认证配置或批准命令不可用'};
    }
    const record=await this.store.saveText('console',JSON.stringify({kind:'auth',status:failure?.kind??'success',...(failure?{message:failure.message}:{})}),meta);
    // 成功记录可能已落盘，但取消后不得发布可使用身份的 session。
    if(signal.aborted)throw new AuthenticationError('cancelled','认证已取消',[record.id]);
    if(failure) throw new AuthenticationError(failure.kind,failure.message,[record.id]);
    const client:HttpClientFacade={
      request:(input,requestMeta)=>{
        let sameOrigin=false;
        try { sameOrigin=new URL(input.url).origin===this.origin; } catch { /* 无效 URL 交给底层策略拒绝并采证。 */ }
        return this.client.request(input,requestMeta,sameOrigin?headers:[]);
      },
      recordBlocked:requestMeta=>this.client.recordBlocked(requestMeta),
    };
    return {client,evidenceIds:[record.id]};
  }
}
