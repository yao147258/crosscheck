import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { APPROVAL_COLOR, APPROVAL_LABEL, Footer, List, StatusLine, clampIndex, moveIndex } from '../components';
import { useReview } from '../context';
import { useAction, useEditorPause, useLoader } from '../hooks';
import { navKey, type Nav } from '../routes';
import { approveProfileFile, editProfileFile, loadProfileOverview, revokeProfileFile } from '../state/profile';

export function ProfileView({ nav }: { nav: Nav }) {
  const { session, editor } = useReview();
  const { data, error, reload } = useLoader(() => loadProfileOverview(session), [session]);
  const { status, run } = useAction(reload);
  const pause = useEditorPause();
  const [index, setIndex] = useState(0);
  const rows = data?.rows ?? [];
  const current = clampIndex(index, rows.length);
  const row = rows[current];
  useInput((input, key) => {
    if (navKey(input, key, nav)) return;
    if (key.upArrow || key.downArrow) { setIndex(moveIndex(current, rows.length, key)); return; }
    if (!row) return;
    if (input === 'a') void run(() => approveProfileFile(session, row.name));
    if (input === 'r') void run(() => revokeProfileFile(session, row.name));
    if (input === 'e') void run(() => pause(() => editProfileFile(session, editor, row.name)));
  });
  return (
    <Box flexDirection="column">
      <Text bold>画像审核</Text>
      <List items={rows.map((r) => ({ key: r.name, label: `${r.name.padEnd(18)} ${APPROVAL_LABEL[r.status]}`, color: APPROVAL_COLOR[r.status] }))} index={current} />
      {row?.error && <Text color="red">{row.error}</Text>}
      {data?.crossCheck && <Text color="yellow">交叉校验未通过：{data.crossCheck}</Text>}
      {error && <Text color="red">{error}</Text>}
      <StatusLine status={status} />
      <Footer keys="↑↓ 移动 · a 确认 · r 撤销 · e 编辑 · Esc 返回 · q 退出" />
    </Box>
  );
}
