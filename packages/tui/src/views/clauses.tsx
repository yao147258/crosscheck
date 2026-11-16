import { Box, Text, useInput, useWindowSize } from 'ink';
import { useState } from 'react';
import { APPROVAL_COLOR, APPROVAL_LABEL, Footer, List, StatusLine, clampIndex, moveIndex } from '../components';
import { handleConfirm, type PendingConfirm } from '../confirm';
import { useReview } from '../context';
import { useAction, useEditorPause, useLoader } from '../hooks';
import { navKey, type Nav } from '../routes';
import { approveAllClauses, approveClause, deleteClause, editClause, loadClauseRows, markClauseUnclear, revokeClause } from '../state/clauses';

export function ClausesView({ nav, module }: { nav: Nav; module: string }) {
  const { session, editor } = useReview();
  const { rows: terminalRows, columns } = useWindowSize();
  const compact = columns < 70 || terminalRows < 24;
  const { data, error, reload } = useLoader(() => loadClauseRows(session, module), [session, module]);
  const { status, setStatus, run } = useAction(reload);
  const pause = useEditorPause();
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState<PendingConfirm>();
  const rows = data ?? [];
  const current = clampIndex(index, rows.length);
  const row = rows[current];
  useInput((input, key) => {
    if (key.ctrl) return;
    if (handleConfirm(input, pending, () => setPending(undefined), run, setStatus)) return;
    if (navKey(input, key, nav)) return;
    if (key.upArrow || key.downArrow) { setIndex(moveIndex(current, rows.length, key)); return; }
    if (!data) return;
    if (input === 'A') { setPending({ text: '确认所有 active 未确认条款？(y/N)', action: () => approveAllClauses(session, module) }); return; }
    if (!row) return;
    const id = row.clause.id;
    if (input === 'a') void run(() => approveClause(session, module, id));
    if (input === 'r') void run(() => revokeClause(session, module, id));
    if (input === 'u') void run(() => markClauseUnclear(session, module, id));
    if (input === 'e') void run(() => pause(() => editClause(session, editor, module, id)));
    if (input === 'd') setPending({ text: `删除 ${id}？(y/N)`, action: () => deleteClause(session, module, id) });
  });
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">条款审核 · {module}</Text>
      <Box flexDirection="column" maxHeight={Math.max(3, terminalRows - 10)} overflow="hidden" flexShrink={0}>
        <List items={rows.map((r) => ({ key: r.clause.id, label: `${r.clause.id} [${r.clause.status}] ${APPROVAL_LABEL[r.approval]}`, color: APPROVAL_COLOR[r.approval] }))} index={current} maxRows={Math.max(2, Math.floor((terminalRows - 10) / 2))} />
        {!data && !error && <Text dimColor>加载中…</Text>}
        {row && (
          <Box flexDirection="column" flexShrink={0}>
            <Text dimColor wrap={compact ? 'truncate-end' : 'wrap'}>来源 {row.clause.source.file}:{row.clause.source.line}</Text>
            <Text wrap={compact ? 'truncate-end' : 'wrap'}>{row.clause.text}</Text>
            <Text dimColor wrap={compact ? 'truncate-end' : 'wrap'}>摘录 {row.clause.source.excerpt}</Text>
            {row.clause.notes && <Text dimColor>备注 {row.clause.notes}</Text>}
          </Box>
        )}
      </Box>
      {pending && <Text color="yellow">{pending.text}</Text>}
      {error && <Text color="red" wrap="truncate-end">{error}</Text>}
      <Box flexDirection="column" maxHeight={2} overflow="hidden" flexShrink={0}>
        <StatusLine status={status} />
      </Box>
      <Footer keys={compact ? '↑↓ 移动 · a/r/e 确认/撤销/编辑\nu unclear · d 删除 · A 全确认 · Esc/q' : '↑↓ 移动 · a 确认 · r 撤销 · e 编辑 · u 标记 unclear · d 删除 · A 全部确认 · Esc 返回 · q 退出'} />
    </Box>
  );
}
