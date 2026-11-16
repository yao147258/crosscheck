import { Box, Text, type Key } from 'ink';

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

export function List({ items, index }: { items: ListItem[]; index: number }) {
  if (!items.some((item) => !item.header)) return <Text dimColor>（空）</Text>;
  let selectable = -1;
  return (
    <Box flexDirection="column">
      {items.map((item) => {
        if (item.header) return <Text key={item.key} bold>{item.label}</Text>;
        const active = ++selectable === index;
        return <Text key={item.key} color={item.color} inverse={active}>{active ? '› ' : '  '}{item.label}</Text>;
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
