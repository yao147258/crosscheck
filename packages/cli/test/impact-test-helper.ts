import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const impactRoots: string[] = [];
export async function cleanupImpactRepos() {
  await Promise.all(impactRoots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
}
export async function impactRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'impact 测试 ')); impactRoots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', '测试');
  return { root, git };
}
export async function impactPut(root: string, name: string, data: string | Uint8Array) {
  const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data);
}
