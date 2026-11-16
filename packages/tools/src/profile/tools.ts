import { defineTool } from '@crosscheck/agent';
import type { Profile } from '@crosscheck/core';
import type { EvidenceRedactor } from '../evidence/redactor';
import { ProfileSearchSchema, type ProfileSearchOptions } from './schema';
import { createProfileSearch } from './search';
export function createProfileTools(profile:Profile,options:ProfileSearchOptions={},redactor?:EvidenceRedactor){
 const search=createProfileSearch(profile,options,redactor);
 return [defineTool({name:'profile_search',category:'profile',description:'按类型和关键词检索已确认的操作知识；不是业务预期，无源码或任意文件读取',input:ProfileSearchSchema,
 async execute(input,ctx){return search(input,ctx.signal);},
 })];
}
