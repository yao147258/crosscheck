import { ProfileSchema, type Profile } from '@crosscheck/core';
import { createEvidenceRedactor, type EvidenceRedactor } from '../evidence/redactor';
import { ProfileSearchSchema, type ProfileSearchOptions } from './schema';
import type { z } from 'zod';
/** 只消费宿主已经确认的内存快照；不加载文件，不读取环境，不修改批准画像。 */
export function createProfileSearch(profile:Profile,options:ProfileSearchOptions={},redactor?:EvidenceRedactor){
 const p=ProfileSchema.parse(profile);
 const r=redactor??createEvidenceRedactor(p['guardrails.yaml'].redactFields);
 const maxItems=options.maxItems??20,maxChars=options.maxSummaryChars??1000;
 if(!Number.isSafeInteger(maxItems)||maxItems<1||maxItems>50||!Number.isSafeInteger(maxChars)||maxChars<16||maxChars>2000)throw new Error('画像摘要上限不合法');
 const rows:{type:string;name:string;summary:string}[]=[];
 const add=(type:string,name:string,summary:string)=>rows.push({type,name,summary});
 for(const name of Object.keys(p['environments.yaml'].environments))add('environment',name,'已确认运行环境；身份与网络授权由宿主解析');
 for(const [name,op]of Object.entries(p['api-catalog.yaml'].operations))add('api',name,`${op.method} ${r.url(op.path)}（环境 ${op.environment}） ${op.description}\n${op.knowledge.join('\n')}`);
 for(const [name,page]of Object.entries(p['pages.yaml'].pages))add('page',name,`${r.url(page.path)}（环境 ${page.environment}） ${page.description}\n${page.knowledge.join('\n')}`);
 for(const [name,actor]of Object.entries(p['auth.yaml'].actors))add('actor',name,`角色认证类型：${actor.kind}；凭证仅由宿主持有`);
 for(const [name,query]of Object.entries(p['data-model.yaml'].queries))add('query',name,`具名查询；参数：${query.parameters.map(x=>`${x.name}:${x.type}${x.nullable?'（可空）':''}`).join('、')}；执行仍受只读守卫限制`);
 for(const [name,fixture]of Object.entries(p['fixtures.yaml'].fixtures))add('fixture',name,`批准夹具类型：${fixture.kind}；仅准备阶段，使用已批准固定参数`);
 return (input:z.infer<typeof ProfileSearchSchema>,signal:AbortSignal)=>{
  if(signal.aborted)return {status:'cancelled',items:[],truncated:false,notice:'画像检索已取消'};
  input=ProfileSearchSchema.parse(input);
  const keyword=input.keyword.toLocaleLowerCase();
  const matches=rows.map(row=>r.value(row)).filter(row=>(input.type==='all'||row.type===input.type)&&`${row.name} ${row.summary}`.toLocaleLowerCase().includes(keyword));
  const items=matches.slice(0,maxItems).map(row=>({...row,summary:row.summary.length>maxChars?`${row.summary.slice(0,maxChars-6)}…[已截断]`:row.summary,truncated:row.summary.length>maxChars}));
  return {status:'success',items,truncated:matches.length>maxItems,totalMatches:matches.length,notice:'已确认操作知识，非预期标准或业务断言；截断内容不代表完整画像'};
 };
}
