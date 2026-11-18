import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Footer, List, moveIndex } from '../components';
import { useReview } from '../context';
import { useLoader } from '../hooks';
import { navKey, type Nav, type Route } from '../routes';
import { loadHomeSummary } from '../state/home';

export function HomeView({ nav }: { nav: Nav }) {
  const { session } = useReview();
  const { data, error } = useLoader(() => loadHomeSummary(session), [session]);
  const [index, setIndex] = useState(0);
  const n = (value?: number) => value === undefined ? '…' : String(value);
  const entries: { label: string; route: Route }[] = [
    { label: `画像审核（待处理 ${n(data?.profilePending)}）`, route: { name: 'profile' } },
    { label: `条款审核（待处理 ${n(data?.clausesPending)}）`, route: { name: 'modules', kind: 'clauses' } },
    { label: `用例审核（待处理 ${n(data?.casesPending)}）`, route: { name: 'modules', kind: 'cases' } },
    { label: `结果审核（运行 ${n(data?.runs)} 次）`, route: { name: 'runs' } },
    { label: '项目笔记审核', route: { name: 'notes' } },
  ];
  useInput((input, key) => {
    if (navKey(input, key, nav)) return;
    if (key.upArrow || key.downArrow) { setIndex((i) => moveIndex(i, entries.length, key)); return; }
    if (key.return) nav.push(entries[index]!.route);
  });
  return (
    <Box flexDirection="column">
      <List items={entries.map((entry, i) => ({ key: String(i), label: entry.label }))} index={index} />
      {error && <Text color="red">{error}</Text>}
      <Footer keys="↑↓ 移动 · Enter 进入 · q 退出" />
    </Box>
  );
}
