import { Box, Text, useWindowSize, type Key } from 'ink';

export interface Status { kind: 'info' | 'error'; text: string }
export interface ListItem { key: string; label: string; color?: string; header?: boolean }

export const APPROVAL_LABEL: Record<string, string> = {
  approved: '已确认', stale: '确认已失效', none: '未确认', missing: '缺失', invalid: '不合法',
};
export const APPROVAL_COLOR: Record<string, string> = {
  approved: 'green', stale: 'yellow', none: 'white', missing: 'red', invalid: 'red',
};

export function moveIndex(index: number, length: number, key: Pick<Key, 'upArrow' | 'downArrow'>): number {
  if (length === 0) return 0;
  if (key.upArrow) return (index - 1 + length) % length;
  if (key.downArrow) return (index + 1) % length;
  return index;
}

export function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), Math.max(length - 1, 0));
}

export function List({ items, index, maxRows }: { items: ListItem[]; index: number; maxRows?: number }) {
  const { rows } = useWindowSize();
  const limit = Math.max(2, maxRows ?? Math.floor(rows / 2));
  let selectable = -1;
  let header: ListItem | undefined;
  const entries = items.map((item) => {
    if (item.header) header = item;
    return { item, ordinal: item.header ? -1 : ++selectable, header };
  });
  if (selectable < 0) return <Text dimColor>（空）</Text>;
  const activeIndex = entries.findIndex((entry) => entry.ordinal === clampIndex(index, selectable + 1));
  const start = Math.max(0, activeIndex - Math.floor((limit - 2) / 2));
  const visible = entries.slice(start, start + limit);
  // 窗口从组内开始时补回组标题，且不挤掉选中项。
  if (visible[0]?.header && !visible[0].item.header) {
    visible.unshift({ item: visible[0].header, ordinal: -1, header: visible[0].header });
    visible.splice(limit);
  }
  return (
    <Box flexDirection="column" flexShrink={0}>
      {visible.map(({ item, ordinal }) => {
        if (item.header) return <Text key={item.key} bold color={item.color} wrap="truncate-end">{item.label}</Text>;
        const active = ordinal === clampIndex(index, selectable + 1);
        return <Text key={item.key} color={item.color} inverse={active} wrap="truncate-end">{active ? '› ' : '  '}{item.label}</Text>;
      })}
    </Box>
  );
}

export function StatusLine({ status }: { status?: Status }) {
  if (!status) return null;
  return <Text color={status.kind === 'error' ? 'red' : 'green'}>{status.text}</Text>;
}

export function Footer({ keys }: { keys: string }) {
  return <Text dimColor>{keys}</Text>;
}
