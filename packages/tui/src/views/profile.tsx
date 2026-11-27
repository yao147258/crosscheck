import { Box, Text, useInput, useWindowSize } from 'ink';
import { useContext, useState } from 'react';
import { APPROVAL_COLOR, APPROVAL_LABEL, Footer, List, ReviewDetails, StatusLine, clampIndex, moveIndex } from '../components';
import { ActionContext, useReview } from '../context';
import { useAction, useEditorPause, useLoader } from '../hooks';
import { navKey, type Nav } from '../routes';
import { approveProfileFile, editProfileFile, loadProfileOverview, revokeProfileFile } from '../state/profile';

export function ProfileView({ nav }: { nav: Nav }) {
  const { session, editor } = useReview();
  const actions = useContext(ActionContext);
  const { rows: terminalRows, columns } = useWindowSize();
  const compact = columns < 70 || terminalRows < 24;
  const { data, error, reload } = useLoader(() => loadProfileOverview(session), [session], overview => {
    const invalid = overview.rows.find(row => row.status === 'invalid');
    if (invalid) return new Error(`${invalid.name} 不合法：${invalid.error}`);
    if (overview.crossCheck) return new Error(`交叉校验未通过：${overview.crossCheck}`);
    return undefined;
  });
  const { status, setStatus, run } = useAction(reload);
  const pause = useEditorPause();
  const [index, setIndex] = useState(0);
  const [details, setDetails] = useState(false);
  const rows = data?.rows ?? [];
  const current = clampIndex(index, rows.length);
  const row = rows[current];
  useInput((input, key) => {
    if (key.ctrl) return;
    if (navKey(input, key, nav)) return;
    if (key.upArrow || key.downArrow) { setIndex(moveIndex(current, rows.length, key)); return; }
    if (!row) return;
    if (key.return) {
      if (actions?.busy.current) setStatus({ kind: 'error', text: '请等待当前操作完成' });
      else setDetails(true);
      return;
    }
    if (input === 'a') void run(() => approveProfileFile(session, row.name));
    if (input === 'r') void run(() => revokeProfileFile(session, row.name));
    if (input === 'e') void run(() => pause(() => editProfileFile(session, editor, row.name)));
  }, { isActive: !(details && row) });
  if (details && row) return <ReviewDetails title={row.name} lines={row.details} close={() => setDetails(false)} quit={nav.quit} />;
  return (
    <Box flexDirection="column">
      <Text bold>画像审核</Text>
      <List items={rows.map((r) => ({ key: r.name, label: `${r.name.padEnd(18)} ${APPROVAL_LABEL[r.status]}`, color: APPROVAL_COLOR[r.status] }))} index={current} maxRows={Math.max(2, terminalRows - 9)} />
      {!data && !error && <Text dimColor>加载中…</Text>}
      {row?.error && <Text color="red" wrap="truncate-end">{row.error}</Text>}
      {data?.crossCheck && <Text color="yellow" wrap="truncate-end">交叉校验未通过：{data.crossCheck}</Text>}
      {error && <Text color="red" wrap="truncate-end">{error}</Text>}
      <Box flexDirection="column" maxHeight={2} overflow="hidden" flexShrink={0}>
        <StatusLine status={status} />
      </Box>
      <Footer keys={compact ? 'Enter 详情 · ↑↓ · a/r/e 确认/撤销/编辑\nEsc 返回 · q 退出' : 'Enter 详情 · ↑↓ 移动 · a 确认 · r 撤销 · e 编辑 · Esc 返回 · q 退出'} />
    </Box>
  );
}
