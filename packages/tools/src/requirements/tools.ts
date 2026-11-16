import { defineTool } from '@crosscheck/agent';
import { ClauseIdSchema, selectPlannableClauses, type Approvals, type Clause } from '@crosscheck/core';
import { z } from 'zod';

export const MAX_REQUIREMENT_RESULTS = 20;

export const RequirementsSearchSchema = z.strictObject({
  query: z.string().max(200).optional(),
  ids: z.array(ClauseIdSchema).max(50).optional(),
}).refine((input) => Boolean(input.query?.trim()) || Boolean(input.ids?.length), '至少提供 query 或 ids');
export type RequirementsSearchInput = z.infer<typeof RequirementsSearchSchema>;

export function searchRequirements(
  clauses: Clause[],
  input: RequirementsSearchInput,
): Array<Pick<Clause, 'id' | 'text' | 'source'>> {
  const query = input.query?.trim().toLowerCase();
  const ids = input.ids?.length ? new Set(input.ids) : undefined;
  return clauses
    .filter((clause) => (!ids || ids.has(clause.id))
      && (!query || [clause.id, clause.text, clause.source.excerpt].some((text) => text.toLowerCase().includes(query))))
    .slice(0, MAX_REQUIREMENT_RESULTS)
    .map(({ id, text, source }) => ({ id, text, source }));
}

export function createRequirementsTools(clauses: Clause[], approvals: Approvals) {
  const usable = selectPlannableClauses(clauses, approvals).ready;
  return [defineTool({
    name: 'requirements_search',
    category: 'requirements',
    description: '检索本模块已确认的验收条款原文（只读）；按 ids 精确获取或按关键词检索，最多返回 20 条',
    input: RequirementsSearchSchema,
    async execute(input) {
      return { items: searchRequirements(usable, input) };
    },
  })];
}
