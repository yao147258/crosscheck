import { defineTool } from '@crosscheck/agent';
import type { EvidenceMeta } from '../network/http-client';
import { FixtureHost, FixtureOperationError } from './host';
import { FixtureInputSchema } from './schema';
export function createFixtureTools(host:FixtureHost,nextMeta:()=>EvidenceMeta){
 return [defineTool({name:'fixture_execute',category:'fixture',description:'仅准备阶段执行已批准名称与固定参数的夹具；输出非业务预期',input:FixtureInputSchema,
  async execute(input,ctx){
   const meta=nextMeta();
   try{return await host.execute(input.name,meta,ctx.signal);}
   catch(error){if(error instanceof FixtureOperationError)return {error:{kind:error.kind,message:error.message},evidenceIds:error.evidenceIds};throw error;}
  },
 })];
}
