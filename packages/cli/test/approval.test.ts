import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
const exec = promisify(execFile);
it('独立人工确认脚本未明确确认时拒绝，不是run自动批准', async () => {
  const root = new URL('../../../', import.meta.url);
  await exec(process.execPath, ['scripts/build.mjs', '--approval'], { cwd: root });
  await expect(exec(process.execPath, ['packages/cli/dist/manual-approve.js'], { cwd: root })).rejects.toMatchObject({ code: 2 });
}, 15000);
