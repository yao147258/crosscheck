import { Box, Text, useInput, useWindowSize } from 'ink';
import { useContext, useState } from 'react';
import { APPROVAL_COLOR, APPROVAL_LABEL, Footer, List, ReviewDetails, StatusLine, clampIndex, moveIndex, type ListItem } from '../components';
import { handleConfirm, type PendingConfirm } from '../confirm';
import { ActionContext, useReview } from '../context';
import { useAction, useEditorPause, useLoader } from '../hooks';
import { navKey, type Nav } from '../routes';
import { approveAllCases, approveCase, deleteCase, editCase, loadCaseOverview, revokeCase, type CaseRow } from '../state/cases';

export function CasesView({ nav, module }: { nav: Nav; module: string }) {
  const { session, editor } = useReview();
  const actions = useContext(ActionContext);
  const { rows: terminalRows, columns } = useWindowSize();
  const compact = columns < 70 || terminalRows < 24;
  const { data, error, reload } = useLoader(() => loadCaseOverview(session, module), [session, module]);
  const { status, setStatus, run } = useAction(reload);
  const pause = useEditorPause();
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState<PendingConfirm>();
  const [details, setDetails] = useState(false);
  const byId = new Map((data?.rows ?? []).map((r) => [r.testCase.id, r]));
  const items: ListItem[] = [];
  const ordered: CaseRow[] = [];
  const push = (id: string) => {
    const r = byId.get(id)!;
    ordered.push(r);
    items.push({ key: id, label: `${id} ${APPROVAL_LABEL[r.approval]} · 覆盖 ${r.testCase.covers.join(', ')}`, color: APPROVAL_COLOR[r.approval] });
  };
  for (const group of data?.groups ?? []) {
    items.push({ key: `h:${group.clauseId}`, label: `▸ ${group.clauseId}`, header: true, color: data?.coverage.uncovered.includes(group.clauseId) ? 'yellow' : undefined });
    group.caseIds.forEach(push);
  }
  if (data?.ungrouped.length) {
    items.push({ key: 'h:other', label: '▸ 其他（第一个覆盖条款未确认）', header: true });
    data.ungrouped.forEach(push);
  }
  const current = clampIndex(index, ordered.length);
  const row = ordered[current];
  useInput((input, key) => {
    if (key.ctrl) return;
    if (handleConfirm(input, pending, () => setPending(undefined), run, setStatus)) return;
    if (navKey(input, key, nav)) return;
    if (key.upArrow || key.downArrow) { setIndex(moveIndex(current, ordered.length, key)); return; }
    if (!data) return;
    if (input === 'A') { setPending({ text: '确认本模块所有可确认的用例？(y/N)', action: () => approveAllCases(session, module) }); return; }
    if (!row) return;
    if (key.return) {
      if (actions?.busy.current) setStatus({ kind: 'error', text: '请等待当前操作完成' });
      else setDetails(true);
      return;
    }
    const id = row.testCase.id;
    if (input === 'a') void run(() => approveCase(session, module, id));
    if (input === 'r') void run(() => revokeCase(session, module, id));
    if (input === 'e') void run(() => pause(() => editCase(session, editor, module, id)));
    if (input === 'd') setPending({ text: `删除 ${id}？(y/N)`, action: () => deleteCase(session, module, id) });
  }, { isActive: !(details && row) });
  if (details && row) return (
    <ReviewDetails title={row.testCase.id} close={() => setDetails(false)} quit={nav.quit} lines={[
      `${row.testCase.id} ${APPROVAL_LABEL[row.approval]}`,
      `覆盖 ${row.testCase.covers.join(', ')}`,
      `角色 ${row.testCase.actor} · 夹具 ${row.testCase.fixtures.join(', ') || '无'}`,
      ...row.testCase.steps.map((step, i) => `${i + 1}. ${step}`),
      ...row.testCase.expectations.flatMap((e) => [`${e.id} ${e.text}`, `证据 ${e.evidence.join(', ')}`]),
    ]} />
  );
  const cov = data?.coverage;
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">用例审核 · {module}</Text>
      {cov && <Text wrap="truncate-end">覆盖率 {cov.covered.length}/{cov.covered.length + cov.uncovered.length}</Text>}
      {cov && cov.uncovered.length > 0 && <Text color="yellow" wrap="truncate-end">未覆盖：{cov.uncovered.join(', ')}</Text>}
      <Box flexDirection="column" maxHeight={Math.max(3, terminalRows - 12)} overflow="hidden" flexShrink={0}>
        <List items={items} index={current} maxRows={Math.max(2, Math.floor((terminalRows - 12) / 2))} />
        {!data && !error && <Text dimColor>加载中…</Text>}
        {row && (
          <Box flexDirection="column" flexShrink={0}>
            <Text wrap={compact ? 'truncate-end' : 'wrap'}>角色 {row.testCase.actor} · 夹具 {row.testCase.fixtures.join(', ') || '无'}</Text>
            {row.testCase.steps.map((step, i) => <Text key={`s${i}`} wrap={compact ? 'truncate-end' : 'wrap'}>{i + 1}. {step}</Text>)}
            {row.testCase.expectations.map((e) => <Text key={e.id} dimColor wrap={compact ? 'truncate-end' : 'wrap'}>{e.id} {e.text} [{e.evidence.join(', ')}]</Text>)}
          </Box>
        )}
      </Box>
      {pending && <Text color="yellow">{pending.text}</Text>}
      {error && <Text color="red" wrap="truncate-end">{error}</Text>}
      <Box flexDirection="column" maxHeight={2} overflow="hidden" flexShrink={0}>
        <StatusLine status={status} />
      </Box>
      <Footer keys={compact ? 'Enter 详情 · ↑↓ · a/r/e 确认/撤销/编辑\nd 删除 · A 全确认 · Esc/q 返回/退出' : 'Enter 详情 · ↑↓ 移动 · a 确认 · r 撤销 · e 编辑 · d 删除 · A 全部确认 · Esc 返回 · q 退出'} />
    </Box>
  );
}
