import { defineTool } from '@crosscheck/agent';
import { DbInputSchema, DbOperationError, type DbMeta, type PostgresReader } from './postgres';

export function createDbTools(reader: PostgresReader, nextMeta: () => DbMeta) {
  return [defineTool({
    name: 'db_query', category: 'db', description: '执行只读具名查询或保守 SELECT；截断结果不能用于完整集合结论', input: DbInputSchema,
    async execute(input, ctx) {
      try { return await reader.query(input, nextMeta(), ctx.signal); }
      catch (error) {
        if (error instanceof DbOperationError) return { error: { kind: error.kind, message: error.message }, evidenceIds: error.evidenceIds };
        throw error;
      }
    },
  })];
}
