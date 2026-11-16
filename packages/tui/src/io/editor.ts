import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ArtifactStore } from '@crosscheck/core';

export interface EditorCommand { program: string; args: string[] }
export interface EditorHost { edit(text: string): Promise<string> }
export type SpawnSyncLike = (
  program: string,
  args: string[],
  options: { stdio: 'inherit'; shell: false },
) => { status: number | null; error?: Error };

/** 双引号内保留空白，反斜杠原样保留，不做 shell 展开。 */
export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (started) { out.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quoted) throw new Error('编辑器命令中的引号未闭合');
  if (started) out.push(current);
  return out;
}

export function resolveEditorCommand(env: Record<string, string | undefined>): EditorCommand | undefined {
  for (const key of ['VISUAL', 'EDITOR']) {
    const value = env[key]?.trim();
    if (!value) continue;
    const [program, ...args] = parseCommandLine(value);
    if (program) return { program, args };
  }
  return undefined;
}

export function createEditorHost(
  artifacts: ArtifactStore,
  env: Record<string, string | undefined>,
  spawn: SpawnSyncLike = (program, args, options) => spawnSync(program, args, options),
): EditorHost {
  return {
    async edit(text) {
      const command = resolveEditorCommand(env);
      if (!command) throw new Error('请设置 VISUAL 或 EDITOR 环境变量后再编辑');
      const rel = `.edit/${randomUUID()}.yaml`;
      try {
        await artifacts.writeBytes(rel, Buffer.from(text));
        const result = spawn(command.program, [...command.args, artifacts.resolve(rel)], { stdio: 'inherit', shell: false });
        if (result.error) throw new Error(`无法启动编辑器 ${command.program}：${result.error.message}`);
        if (result.status !== 0) throw new Error(`编辑器以退出码 ${result.status} 结束，已放弃修改`);
        return (await artifacts.readBytes(rel))?.toString('utf8') ?? '';
      } finally {
        await artifacts.remove(rel).catch(() => {});
      }
    },
  };
}
