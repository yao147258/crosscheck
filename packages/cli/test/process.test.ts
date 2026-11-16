import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
const exec = promisify(execFile);
const root = new URL('../../../', import.meta.url);
it('真实build产物能在无TS加载器子进程运行help/run/report和本地bin', async () => {
  await exec(process.execPath, ['scripts/build.mjs'], { cwd: root });
  const cli = new URL('../dist/index.js', import.meta.url);
  expect((await exec(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--help'])).stdout).toContain('Crosscheck');
  await expect(exec(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'run', '--project', '不存在的项目'])).rejects.toMatchObject({ code: 2 });
  await expect(exec(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'report', '20261113T123456789Z-00000000000000000000000000000000'])).rejects.toMatchObject({ code: 3 });
  const bin = process.platform === 'win32'
    ? await exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm crosscheck --help'], { cwd: root })
    : await exec('pnpm', ['crosscheck', '--help'], { cwd: root });
  expect(bin.stdout).toContain('Crosscheck');
}, 30000);
