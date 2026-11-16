import { Box, Text, useInput, useWindowSize } from 'ink';
import { useState } from 'react';
import { Footer, List, clampIndex, moveIndex } from '../components';
import { useReview } from '../context';
import { useLoader } from '../hooks';
import { navKey, type Nav } from '../routes';
import { listReviewModules } from '../state/clauses';

export function ModulesView({ nav, kind }: { nav: Nav; kind: 'clauses' | 'cases' }) {
  const { session } = useReview();
  const { rows } = useWindowSize();
  const { data, error } = useLoader(() => listReviewModules(session), [session]);
  const [index, setIndex] = useState(0);
  const modules = data ?? [];
  const current = clampIndex(index, modules.length);
  useInput((input, key) => {
    if (key.ctrl) return;
    if (navKey(input, key, nav)) return;
    if (key.upArrow || key.downArrow) { setIndex(moveIndex(current, modules.length, key)); return; }
    const module = modules[current];
    if (key.return && module) nav.push({ name: kind, module });
  });
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">{kind === 'clauses' ? '条款审核' : '用例审核'} · 选择模块</Text>
      <List items={modules.map((m) => ({ key: m, label: m }))} index={current} maxRows={rows - 6} />
      {!data && !error && <Text dimColor>加载中…</Text>}
      {error && <Text color="red">{error}</Text>}
      <Footer keys="↑↓ 移动 · Enter 进入 · Esc 返回 · q 退出" />
    </Box>
  );
}
