import type { GuardResult } from '../verdict/evidence-guard';

const FORBIDDEN_WORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|CALL|EXEC|EXECUTE|COPY|LOCK|INTO|ATTACH|DETACH|PRAGMA|VACUUM|LOAD|HANDLER|SET|RENAME|COMMENT|REINDEX|CLUSTER|REFRESH|NOTIFY|LISTEN)\b/i;

const FORBIDDEN_FUNCS =
  /\b(pg_sleep\w*|sleep|benchmark|dblink\w*|lo_\w+|pg_read_\w+|pg_write_\w+|pg_ls_dir|load_file|pg_terminate_backend|pg_cancel_backend|set_config|nextval|setval)\s*\(/i;

type ScanResult = { ok: true; body: string } | { ok: false; reason: string };

/**
 * 从左到右单遍扫描 SQL 文本：
 * - `--` 开始到行尾的行注释、`/* ... *` + `/` 块注释 → 替换为一个空格
 * - `'...'`（`''` 为转义）字符串字面量 → 替换为占位 `''`
 * - `"..."`、`` ` ... ` ``（引号/反引号标识符，重复引号为转义）→ 替换为其内部文本（去掉引号本身），
 *   这样引号包裹的函数名/关键字仍会被后续的黑名单检查命中（宁可误拒）
 * 任何未闭合的字符串/标识符/块注释都直接判定失败。
 */
function scanSql(sql: string): ScanResult {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      let end = sql.indexOf('\n', i + 2);
      if (end === -1) end = n;
      out += ' ';
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return { ok: false, reason: '块注释未闭合' };
      out += ' ';
      i = end + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (!closed) return { ok: false, reason: '字符串未闭合' };
      out += "''";
      i = j;
      continue;
    }
    if (ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let content = '';
      let closed = false;
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            content += quote;
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        content += sql[j];
        j += 1;
      }
      if (!closed) return { ok: false, reason: '引号标识符未闭合' };
      out += content;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { ok: true, body: out };
}

/**
 * 只读 SQL 校验（保守策略，宁可误拒）。
 * 这是第一道防线；数据库工具还会在只读事务/只读账号中执行（计划 2）。
 */
export function checkReadonlySql(sql: string): GuardResult {
  if (sql.includes('\\')) return { ok: false, reason: '不允许使用反斜杠转义' };
  if (sql.includes('#')) return { ok: false, reason: '不允许使用 # 注释' };
  if (sql.includes('/*!')) return { ok: false, reason: '不允许使用 /*! 条件注释' };
  if (sql.includes('$$') || /\$[A-Za-z_]\w*\$/.test(sql)) {
    return { ok: false, reason: '不允许使用美元符引号' };
  }
  const scanned = scanSql(sql);
  if (!scanned.ok) return scanned;
  let body = scanned.body.trim();
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
