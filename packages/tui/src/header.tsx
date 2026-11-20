import { Box, Text } from 'ink';

export const safeText = (text: string) => text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');

const banner = String.raw`  ____ ____   ___  ____ ____   ____ _   _ _____ ____ _  __
 / ___|  _ \ / _ \/ ___/ ___| / ___| | | | ____/ ___| |/ /
| |   | |_) | | | \___ \___ \| |   | |_| |  _|| |   | ' /
| |___|  _ <| |_| |___) |__) | |___|  _  | |__| |___| . \
 \____|_| \_\\___/|____/____/ \____|_| |_|_____\____|_|\_\ `;

const ROLES = ['extractor', 'planner', 'executor', 'reviewer'] as const;
const SUBTITLE = 'AI Agent Command Line Client';
const BANNER_WIDTH = 58;

export interface SessionInfo {
  version: string;
  models: Record<(typeof ROLES)[number], string> | undefined;
  configFile?: string;
}

const pad = (value: number) => String(value).padStart(2, '0');
export const formatTime = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

export function SessionHeader({ info, width, busy, launchedAt }: { info?: SessionInfo; width: number; busy: boolean; launchedAt: string }) {
  const rule = <Text color="gray">{'─'.repeat(Math.max(1, width))}</Text>;
  const version = info ? `v${safeText(info.version)}` : undefined;
  const sideBySide = width >= BANNER_WIDTH + 34;
  const title = width >= BANNER_WIDTH + 1
    ? sideBySide
      ? <Box>
        <Box flexShrink={0}><Text color="cyan">{banner}</Text></Box>
        <Box marginLeft={2} paddingLeft={2} flexDirection="column" justifyContent="center" flexShrink={0}
          borderStyle="single" borderColor="gray" borderTop={false} borderBottom={false} borderRight={false}>
          {version && <Text bold color="cyanBright">{version}</Text>}
          <Text>{SUBTITLE}</Text>
        </Box>
      </Box>
      : <Box flexDirection="column">
        <Text color="cyan">{banner}</Text>
        <Text>{version && <Text bold color="cyanBright">{version} </Text>}{SUBTITLE}</Text>
      </Box>
    : <Box flexDirection="column">
      <Text bold color="cyan">Crosscheck{version ? ` ${version}` : ''}</Text>
      <Text wrap="truncate-end">{SUBTITLE}</Text>
    </Box>;
  if (!info) return <Box flexDirection="column">{title}</Box>;
  const columns = width >= 60;
  const nameWidth = Math.max(...ROLES.map((role) => role.length));
  return (
    <Box flexDirection="column">
      {title}
      {rule}
      <Box flexDirection={columns ? 'row' : 'column'}>
        <Box flexDirection="column" width={columns ? '50%' : undefined} flexShrink={0}>
          <Text><Text color="blue">■ </Text><Text bold color="blue">Agents</Text></Text>
          {ROLES.map((role) => (
            <Text key={role} wrap="truncate-end"><Text color="gray">› </Text>{role.padEnd(nameWidth)}<Text color="gray"> : </Text>{safeText(info.models?.[role] ?? '未配置')}</Text>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1} marginTop={columns ? 0 : 1}
          {...(columns ? { borderStyle: 'single' as const, borderColor: 'gray', borderTop: false, borderBottom: false, borderRight: false, paddingLeft: 2 } : {})}>
          <Text><Text color="green">● </Text><Text bold color="green">Status</Text></Text>
          <Text wrap="truncate-end"><Text color="gray">▶ </Text>运行状态：{busy ? <Text color="yellow">执行中</Text> : <Text color="green">运行中</Text>}</Text>
          <Text wrap="truncate-end"><Text color="gray">◷ </Text>启动时间：{launchedAt}</Text>
          {info.configFile && <Text wrap="truncate-end"><Text color="gray">▤ </Text>配置文件：{safeText(info.configFile)}</Text>}
        </Box>
      </Box>
      {rule}
    </Box>
  );
}
