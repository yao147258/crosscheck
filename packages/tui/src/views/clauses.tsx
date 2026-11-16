import { Text, useInput } from 'ink';
import { navKey, type Nav } from '../routes';

export function ClausesView({ nav }: { nav: Nav; module: string }) {
  useInput((input, key) => { navKey(input, key, nav); });
  return <Text dimColor>尚未实现 · Esc 返回 · q 退出</Text>;
}
