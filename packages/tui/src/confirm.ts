import type { Status } from './components';

export interface PendingConfirm { text: string; action: () => Promise<string> }

export function handleConfirm(
  input: string,
  pending: PendingConfirm | undefined,
  clear: () => void,
  run: (fn: () => Promise<string>) => Promise<void>,
  setStatus: (status: Status) => void,
): boolean {
  if (!pending) return false;
  clear();
  if (input === 'y') void run(pending.action);
  else setStatus({ kind: 'info', text: '已取消' });
  return true;
}
