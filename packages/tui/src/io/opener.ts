import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { EditorCommand } from './editor';

export type SpawnLike = (
  program: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore'; shell: false },
) => EventEmitter & { unref(): void };

export function openerCommand(platform: NodeJS.Platform, file: string): EditorCommand {
  if (platform === 'win32') return { program: 'explorer.exe', args: [file] };
  if (platform === 'darwin') return { program: 'open', args: [file] };
  return { program: 'xdg-open', args: [file] };
}

export function createOpener(
  platform: NodeJS.Platform = process.platform,
  spawnFn: SpawnLike = (program, args, options) => spawn(program, args, options),
): (file: string) => Promise<void> {
  return (file) => new Promise((resolve, reject) => {
    const fail = (error: Error) => reject(new Error(`无法打开证据：${error.message}`, { cause: error }));
    const { program, args } = openerCommand(platform, file);
    try {
      const child = spawnFn(program, args, { detached: true, stdio: 'ignore', shell: false });
      child.once('error', fail);
      child.once('spawn', () => { child.unref(); resolve(); });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
