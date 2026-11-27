import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectEntry, ProjectLister } from './types';

const MAX_BYTES = 1024 * 1024;

/** 路径被安全规则拒绝，不等同于宿主读取故障。 */
export class UnsafeProjectPathError extends Error {}

export function isCredential(name: string): boolean {
  const lower = name.toLowerCase();
  return (lower.startsWith('.env') && lower !== '.env.example') ||
    /^(?:\.ssh|\.aws|\.gnupg|\.npmrc|\.pypirc|\.netrc|\.dockerconfigjson|(?:credentials|secrets?|tokens?)(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/.test(lower) ||
    /\.(?:pem|key|p12|pfx|keystore)$/.test(lower);
}

export function isSafeProjectPath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  return !!normalized && !path.posix.isAbsolute(normalized) && !path.win32.isAbsolute(file) && !/^[a-z]:/i.test(normalized) && !/[\x00-\x1f\x7f]/.test(normalized) && !normalized.split('/').some((part) => part === '..' || (part !== '.' && /[. ]$/.test(part)) || isCredential(part) || part.includes(':') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part));
}

/** 先检查原始路径，再统一分隔符和点段；绝不折叠父目录。 */
export function normalizeSafeProjectPath(file: string): string | undefined {
  if (!isSafeProjectPath(file)) return undefined;
  return file.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.').join('/') || undefined;
}

export function createProjectReader(projectRoot: string): ProjectLister {
  return {
    async list(dir, signal, options) {
      signal?.throwIfAborted();
      const normalized = (dir || '.').replaceAll('\\', '/');
      const parts = normalized.split('/');
      if (!isSafeProjectPath(dir || '.')) {
        throw new UnsafeProjectPathError('不允许读取该路径');
      }
      let root: string;
      try { root = await realpath(projectRoot); }
      catch { signal?.throwIfAborted(); throw new Error('读取项目文件失败'); }
      signal?.throwIfAborted();
      let current = root;
      try {
        for (const part of parts) {
          if (!part || part === '.') continue;
          current = path.join(current, part);
          const stat = await lstat(current);
          signal?.throwIfAborted();
          if (stat.isSymbolicLink()) throw new UnsafeProjectPathError('不允许读取符号链接');
        }
        const resolved = await realpath(current);
        signal?.throwIfAborted();
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new UnsafeProjectPathError('不允许读取项目外文件');
        if (options?.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0)) throw new Error('目录条目上限必须为非负整数');
        const directory = await opendir(current);
        const entries: ProjectEntry[] = [];
        let seen = 0;
        for await (const entry of directory) {
          signal?.throwIfAborted();
          if (options?.maxEntries !== undefined && seen >= options.maxEntries) {
            options.onDiagnostic?.('目录条目达到上限，已截断；受底层目录顺序影响，可能遗漏关键文件');
            break;
          }
          seen++;
          options?.onEntry?.();
          let stat;
          try { stat = await lstat(path.join(current, entry.name)); }
          catch { signal?.throwIfAborted(); options?.onDiagnostic?.('部分目录条目读取失败'); continue; }
          signal?.throwIfAborted();
          const item: ProjectEntry = { name: entry.name, type: stat.isDirectory() ? 'directory' : 'file', size: stat.isDirectory() ? 0 : stat.size };
          if (stat.isSymbolicLink()) item.link = true;
          entries.push(item);
        }
        return entries;
      } catch (error) {
        signal?.throwIfAborted();
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          options?.onDiagnostic?.('目录已不存在，扫描不完整');
          return [];
        }
        if (error instanceof Error && !('code' in error)) throw error;
        throw new Error('读取项目文件失败');
      }
    },
    async readText(file, signal) {
      signal?.throwIfAborted();
      const normalized = file.replaceAll('\\', '/');
      const parts = normalized.split('/');
      if (!isSafeProjectPath(file)) {
        throw new UnsafeProjectPathError('不允许读取该路径');
      }
      let root: string;
      try {
        root = await realpath(projectRoot);
      } catch {
        signal?.throwIfAborted();
        throw new Error('读取项目文件失败');
      }
      signal?.throwIfAborted();
      let current = root;
      try {
        for (const part of parts) {
          if (!part || part === '.') continue;
          current = path.join(current, part);
          const stat = await lstat(current);
          signal?.throwIfAborted();
          if (stat.isSymbolicLink()) throw new UnsafeProjectPathError('不允许读取符号链接');
        }
        const resolved = await realpath(current);
        signal?.throwIfAborted();
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new UnsafeProjectPathError('不允许读取项目外文件');
        }
        const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
        const handle = await open(current, flags);
        try {
          const stat = await handle.stat();
          signal?.throwIfAborted();
          if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('只允许读取大小不超过 1 MiB 的普通文件');
          const buffer = Buffer.alloc(MAX_BYTES + 1);
          let total = 0;
          while (total < buffer.length) {
            signal?.throwIfAborted();
            const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
            if (!bytesRead) break;
            total += bytesRead;
          }
          signal?.throwIfAborted();
          if (total > MAX_BYTES) throw new Error('文件超过大小限制');
          return buffer.subarray(0, total).toString('utf8');
        } finally {
          await handle.close();
        }
      } catch (error) {
        signal?.throwIfAborted();
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
        if (error instanceof Error && !('code' in error)) throw error;
        throw new Error('读取项目文件失败');
      }
    },
  };
}
