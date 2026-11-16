import { Box, Text, useInput, useWindowSize } from 'ink';
import { useRef, useState } from 'react';
import { Footer, List, ReviewDetails, clampIndex, moveIndex } from '../components';
import { useReview } from '../context';
import { useLoader } from '../hooks';
import { navKey, type Nav } from '../routes';
import { listRuns } from '../state/results';

export function RunsView({ nav }: { nav: Nav }) {
  const { session } = useReview();
  const { rows: terminalRows } = useWindowSize();
  const { data, error } = useLoader(() => listRuns(session), [session]);
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  const entering = useRef(false);
  const [details, setDetails] = useState<string[]>();
  const detailsOpen = useRef(false);
  const runs = data ?? [];
  const current = clampIndex(index, runs.length);
  useInput((input, key) => {
    if (key.ctrl || entering.current || detailsOpen.current) return;
    if (navKey(input, key, nav)) return;
    if (input === 's' && error) { detailsOpen.current = true; setDetails([error]); return; }
    const active = clampIndex(indexRef.current, runs.length);
    if (key.upArrow || key.downArrow) {
      indexRef.current = moveIndex(active, runs.length, key);
      setIndex(indexRef.current);
      return;
    }
    const runId = runs[active];
    if (key.return && runId) { entering.current = true; nav.push({ name: 'results', runId }); }
  }, { isActive: !details });
  if (details) return <ReviewDetails title="加载错误" lines={details} close={() => { detailsOpen.current = false; setDetails(undefined); }} quit={nav.quit} />;
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">结果审核 · 选择运行（新的在前）</Text>
      {!data && !error && <Text dimColor>加载中…</Text>}
      {data && runs.length === 0 ? <Text dimColor>暂无运行</Text> : <List items={runs.map((r) => ({ key: r, label: r }))} index={current} maxRows={Math.max(2, terminalRows - 7)} />}
      {error && <Text color="red" wrap="truncate-end">{error}</Text>}
      <Footer keys={'↑↓ 移动 · Enter 进入 · s 错误详情\nEsc 返回 · q 退出'} />
    </Box>
  );
}
