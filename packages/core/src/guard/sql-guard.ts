import type { GuardResult } from '../verdict/evidence-guard';

const FORBIDDEN_WORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|CALL|EXEC|EXECUTE|COPY|LOCK|INTO|ATTACH|DETACH|PRAGMA|VACUUM|LOAD|HANDLER|SET|RENAME|COMMENT|REINDEX|CLUSTER|REFRESH|NOTIFY|LISTEN)\b/i;

const FORBIDDEN_FUNCS =
  /\b(pg_sleep\w*|sleep|benchmark|dblink\w*|lo_\w+|pg_read_\w+|pg_write_\w+|pg_ls_dir|load_file|pg_terminate_backend|pg_cancel_backend|set_config|nextval|setval)\s*\(/i;

/** 去掉注释与字符串/标识符字面量，剩下的才是需要检查的 SQL 结构 */
function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``');
}

/**
 * 只读 SQL 校验（保守策略，宁可误拒）。
 * 这是第一道防线；数据库工具还会在只读事务/只读账号中执行（计划 2）。
 */
export function checkReadonlySql(sql: string): GuardResult {
  if (sql.includes('$$') || /\$[A-Za-z_]\w*\$/.test(sql)) {
    return { ok: false, reason: '不允许使用美元符引号' };
  }
  let body = stripLiterals(sql).trim();
  if (body.endsWith(';')) body = body.slice(0, -1).trim();
  if (body === '') return { ok: false, reason: 'SQL 为空' };
  if (body.includes(';')) return { ok: false, reason: '只允许单条语句' };
  if (!/^(SELECT|WITH)\b/i.test(body)) return { ok: false, reason: '只允许 SELECT 或 WITH 开头的查询' };
  const word = FORBIDDEN_WORDS.exec(body);
  if (word) return { ok: false, reason: `包含禁止的关键字：${word[1]!.toUpperCase()}` };
  const fn = FORBIDDEN_FUNCS.exec(body);
  if (fn) return { ok: false, reason: `包含禁止的函数：${fn[1]}` };
  return { ok: true };
}
