import { Box, Text, useInput, useWindowSize } from 'ink';
import { useContext, useState } from 'react';
import { APPROVAL_COLOR, APPROVAL_LABEL, Footer, ReviewDetails, StatusLine } from '../components';
import { ActionContext, useReview } from '../context';
import { useAction, useEditorPause, useLoader } from '../hooks';
import { navKey, type Nav } from '../routes';
import { approveNotes, editNotes, loadNotesOverview, revokeNotes } from '../state/notes';

export function NotesView({ nav }: { nav: Nav }) {
  const { session, editor } = useReview();
  const actions = useContext(ActionContext);
  const { rows, columns } = useWindowSize();
  const compact = columns < 70 || rows < 24;
  const { data, error, reload } = useLoader(() => loadNotesOverview(session), [session]);
  const { status, setStatus, run } = useAction(() => { setViewed(undefined); reload(); });
  const pause = useEditorPause();
  const [details, setDetails] = useState(false);
  const [viewed, setViewed] = useState<string>();
  useInput((input, key) => {
    if (key.ctrl) return;
    if (navKey(input, key, nav)) return;
    if (key.return && data) {
      if (actions?.busy.current) setStatus({ kind: 'error', text: '请等待当前操作完成' });
      else { setViewed(data.text); setDetails(true); }
      return;
    }
    if (input === 'a') {
      if (!data || viewed === undefined || viewed !== data.text) setStatus({ kind: 'error', text: '请先查看笔记详情再确认' });
      else void run(() => approveNotes(session, viewed));
    }
    if (input === 'r') void run(() => revokeNotes(session));
    if (input === 'e') void run(() => pause(() => editNotes(session, editor)));
  }, { isActive: !(details && data) });
  if (details && data) {
    const safe = data.text.replace(/\r\n/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return <ReviewDetails title="notes.md" lines={safe.split('\n')} close={() => setDetails(false)} quit={nav.quit} />;
  }
  return <Box flexDirection="column">
    <Text bold>项目笔记审核</Text>
    {data && <Text color={APPROVAL_COLOR[data.status]}>{`notes.md ${APPROVAL_LABEL[data.status]}`}</Text>}
    {!data && !error && <Text dimColor>加载中…</Text>}
    {error && <Text color="red" wrap="truncate-end">{error}</Text>}
    <Box flexDirection="column" maxHeight={2} overflow="hidden" flexShrink={0}><StatusLine status={status} /></Box>
    <Footer keys={compact ? 'Enter 详情 · a/r/e 确认/撤销/编辑\nEsc 返回 · q 退出' : 'Enter 详情 · a 确认 · r 撤销 · e 编辑 · Esc 返回 · q 退出'} />
  </Box>;
}
