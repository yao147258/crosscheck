import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectReader } from './types';

const MAX_BYTES = 1024 * 1024;

function isCredential(name: string): boolean {
  const lower = name.toLowerCase();
  return (lower.startsWith('.env') && lower !== '.env.example') ||
    /^(?:\.ssh|\.aws|\.gnupg|\.npmrc|\.pypirc|\.netrc|\.dockerconfigjson|(?:credentials|secrets?|tokens?)(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/.test(lower) ||
    /\.(?:pem|key|p12|pfx|keystore)$/.test(lower);
}

export function createProjectReader(projectRoot: string): ProjectReader {
  return {
    async readText(file, signal) {
      signal?.throwIfAborted();
      const normalized = file.replaceAll('\\', '/');
      const parts = normalized.split('/');
      if (!normalized || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(file) || /^[a-z]:/i.test(normalized) ||
          parts.some((part) => part === '..' || (part !== '.' && /[. ]$/.test(part)) || isCredential(part) || part.includes(':') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
        throw new Error('不允许读取该路径');
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
          if (stat.isSymbolicLink()) throw new Error('不允许读取符号链接');
        }
        const resolved = await realpath(current);
        signal?.throwIfAborted();
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error('不允许读取项目外文件');
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
