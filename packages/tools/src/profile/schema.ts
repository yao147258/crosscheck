import { z } from 'zod';
export const ProfileSearchSchema=z.strictObject({type:z.enum(['all','environment','api','page','actor','query','fixture']),keyword:z.string().max(200)});
export interface ProfileSearchOptions {maxItems?:number;maxSummaryChars?:number}
