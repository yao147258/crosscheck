import { execFile } from 'node:child_process';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class ImpactInputError extends Error { override name = 'ImpactInputError'; }
export class ImpactHostError extends Error { override name = 'ImpactHostError'; }
export interface TreeEntry { mode: string; type: string; oid: string; size: number; }
const LIMIT = 16 * 1024 * 1024;
const BATCH_TARGET = 8192;
const WINDOWS_COMMAND_LIMIT = 32767;

// 与 Windows 非 shell 参数转义一致：仅引号前及带引号参数末尾的反斜线翻倍。
function windowsArgumentLength(value: string): number {
  if (value && !/[ \t"]/.test(value)) return value.length;
  let length = 2, slashes = 0;
  for (const char of value) {
    if (char === '\\') { slashes++; continue; }
    length += char === '"' ? slashes * 2 + 2 : slashes + char.length;
    slashes = 0;
  }
  return length + slashes * 2;
}

async function git(cwd: string, args: string[], signal?: AbortSignal, limit = LIMIT): Promise<Buffer> {
  if (signal?.aborted) throw new ImpactInputError('操作已取消');
  // 保留 PATH/系统环境，但不接受调用者注入仓库、对象库或配置重定向。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return new Promise((resolve, reject) => {
    let closed = false, settle: (() => void) | undefined;
    // 取消及启动失败的回调可能早于 close；正常回调也可能在 close 监听器内执行。
    // 同时等待结果和 close，不能在回调中再订阅 close，以免错过已发生的事件。
    const finish = () => { if (closed && settle) settle(); };
    try {
      const child = execFile('git', args, { cwd, encoding: 'buffer', shell: false, signal, timeout: 10000, maxBuffer: limit, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } }, (error, stdout) => {
        settle = () => {
          if (!error) return resolve(stdout as Buffer);
          if (signal?.aborted || error.name === 'AbortError') return reject(new ImpactInputError('操作已取消'));
          if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new ImpactInputError('Git 清单超过资源上限'));
          if (error.killed || error.signal) return reject(new ImpactHostError('Git 进程超时或中断'));
          if (typeof (error as NodeJS.ErrnoException).code === 'string') return reject(new ImpactHostError('Git 进程执行失败'));
          reject(error);
        };
        finish();
      });
      child.once('close', () => { closed = true; finish(); });
    } catch {
      // 同步参数或 spawn 异常不会返回可等待 close 的子进程。
      reject(signal?.aborted ? new ImpactInputError('操作已取消') : new ImpactHostError('Git 进程执行失败'));
    }
  });
}

async function hasGitMarker(root: string): Promise<boolean> {
  let dir = root;
  for (;;) {
    try { await lstat(path.join(dir, '.git')); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ImpactHostError('仓库元数据读取失败'); }
    const parent = path.dirname(dir); if (parent === dir) return false; dir = parent;
  }
}

export async function openBaseline(project: string, since: string, signal?: AbortSignal) {
  if (!since || since.startsWith('-') || /[\x00-\x1f\x7f]/.test(since)) throw new ImpactInputError('基线无效');
  let root: string;
  try { root = await realpath(project); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ImpactInputError('项目不存在'); throw new ImpactHostError('项目读取失败'); }
  try { if (!(await stat(root)).isDirectory()) throw new ImpactInputError('项目不是目录'); }
  catch (e) { if (e instanceof ImpactInputError) throw e; throw new ImpactHostError('项目读取失败'); }
  let top: string;
  try { top = (await git(root, ['rev-parse', '--show-toplevel'], signal)).toString('utf8').trimEnd(); }
  catch (e) { if (e instanceof ImpactHostError || e instanceof ImpactInputError) throw e; if (await hasGitMarker(root)) throw new ImpactHostError('仓库元数据读取失败'); throw new ImpactInputError('项目不是 Git 仓库'); }
  try { top = await realpath(top); } catch { throw new ImpactHostError('仓库路径读取失败'); }
  const rel = path.relative(top, root);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new ImpactInputError('项目不在仓库中');
  // 旧版 Git 可能忽略 GIT_NO_LAZY_FETCH；统一拒绝 partial/promisor，绝不试取对象探测能力。
  // config 查询只解析配置，不运行 remote helper；同时检查残留 .promisor 包标记。
  try {
    let partial = false;
    try {
      await git(root, ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], signal);
      partial = true;
    } catch (e) { if ((e as { code?: unknown }).code !== 1) throw e; }
    if (partial) throw new ImpactInputError('暂不支持 partial/promisor 仓库');
    const objectDir = (await git(root, ['rev-parse', '--git-path', 'objects'], signal)).toString('utf8').trimEnd();
    for (const alternate of ['alternates', 'http-alternates']) {
      try { await lstat(path.resolve(root, objectDir, 'info', alternate)); throw new ImpactInputError('暂不支持外部对象库'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    const objects = path.resolve(root, objectDir, 'pack');
    try {
      const directory = await opendir(path.resolve(root, objects));
      let count = 0;
      for await (const entry of directory) {
        if (++count > 2000 || entry.name.endsWith('.promisor')) throw new ImpactInputError('暂不支持 partial/promisor 仓库或元数据超限');
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  } catch (e) { if (e instanceof ImpactInputError || e instanceof ImpactHostError) throw e; throw new ImpactHostError('仓库能力检查失败'); }
  let oid: string;
  try { oid = (await git(root, ['rev-parse', '--quiet', '--verify', '--end-of-options', `${since}^{commit}`], signal)).toString('ascii').trim(); }
  catch (e) {
    if (e instanceof ImpactHostError || e instanceof ImpactInputError) throw e;
    if ((e as { code?: unknown }).code === 1) {
      let raw: string;
      try { raw = (await git(root, ['rev-parse', '--quiet', '--verify', '--end-of-options', since], signal)).toString('ascii').trim(); }
      catch (failure) {
        if (failure instanceof ImpactHostError || failure instanceof ImpactInputError) throw failure;
        if ((failure as { code?: unknown }).code === 1) throw new ImpactInputError('基线不是有效提交');
        throw new ImpactHostError('基线读取失败');
      }
      if (!/^[a-f0-9]{40,64}$/.test(raw)) throw new ImpactInputError('基线不是有效提交');
      try { await git(root, ['cat-file', '-t', raw], signal); }
      catch (failure) { if (failure instanceof ImpactInputError && signal?.aborted) throw failure; throw new ImpactHostError('基线对象读取失败'); }
      throw new ImpactInputError('基线不是有效提交');
    }
    throw new ImpactHostError('基线读取失败');
  }
  if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new ImpactInputError('基线不是有效提交');
  const prefix = rel ? `${rel.split(path.sep).join('/')}/` : '';
  const entries = new Map<string, TreeEntry>(), tracked = new Set<string>();
  let candidatesLimited = false;
  const listedCandidates = new Set<string>();
  const spec = (name: string) => `:(top,literal)${prefix}${name}`;
  const decode = (bytes: Buffer) => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0').filter(Boolean); }
    catch { throw new ImpactInputError('Git 清单包含非法编码'); }
  };
  // 8 KiB 是批次目标而非单路径上限；计入 git、固定参数、分隔空格及终止符。
  async function batched(names: string[], fixed: string[], read: (args: string[]) => Promise<Buffer>): Promise<Buffer[]> {
    const overhead = ['git', ...fixed, '--'].reduce((size, value) => size + windowsArgumentLength(value) + 1, 0);
    const batches: string[][] = []; let batch: string[] = []; let size = overhead;
    for (const name of new Set(names)) {
      const value = spec(name), cost = windowsArgumentLength(value) + 1;
      if (overhead + cost > WINDOWS_COMMAND_LIMIT) throw new ImpactInputError('Git 路径过长');
      if (batch.length && size + cost > BATCH_TARGET) { batches.push(batch); batch = []; size = overhead; }
      batch.push(value); size += cost;
    }
    if (batch.length) batches.push(batch);
    const outputs: Buffer[] = [];
    for (const items of batches) outputs.push(await read([...fixed, '--', ...items]));
    return outputs;
  }
  async function populate(files: string[], recurse: string[] = [], listingLimit = LIMIT) {
    // 每次查询共享预算，调用方可下调但不能放宽；不跨 populate 累计。
    if (!Number.isSafeInteger(listingLimit) || listingLimit < 0 || listingLimit > LIMIT) throw new ImpactInputError('Git 清单预算无效');
    for (const file of files) listedCandidates.add(file);
    let remaining = listingLimit;
    const readListing = async (args: string[], message: string): Promise<Buffer> => {
      let bytes: Buffer;
      try { bytes = await git(root, args, signal, remaining + 1); }
      catch (e) { if (e instanceof ImpactInputError || e instanceof ImpactHostError) throw e; throw new ImpactHostError(message); }
      remaining -= bytes.length;
      if (remaining < 0) throw new ImpactInputError('Git 清单超过资源上限');
      return bytes;
    };
    const ancestors = new Set<string>();
    for (const file of [...files, ...recurse]) {
      const parts = file.split('/'); for (let i = 1; i <= parts.length; i++) ancestors.add(parts.slice(0, i).join('/'));
    }
    const readTree = async (names: string[], recursive: boolean) => {
      if (!names.length) return;
      const outputs = await batched(names, ['ls-tree', ...(recursive ? ['-r'] : []), '-z', '-l', '--full-tree', oid], (args) => readListing(args, '读取 Git 树失败'));
      for (const bytes of outputs) for (const record of decode(bytes)) {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(record);
        if (!match) throw new ImpactHostError('Git 树清单无效');
        const name = match[5]!;
        if (name.startsWith(prefix)) entries.set(name.slice(prefix.length), { mode: match[1]!, type: match[2]!, oid: match[3]!, size: match[4] === '-' ? 0 : Number(match[4]) });
      }
    };
    await readTree([...ancestors], false);
    for (const dir of recurse) {
      const entry = entries.get(dir);
      if (!entry || entry.type !== 'tree') continue;
      const bytes = await readListing(['ls-tree', '-z', '-l', entry.oid], '读取 Git 目录失败');
      for (const record of decode(bytes)) {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(record);
        if (!match) throw new ImpactHostError('Git 树清单无效');
        const name = match[5]!;
        if (/\.ya?ml$/i.test(name)) {
          const file = `${dir}/${name}`;
          if (!listedCandidates.has(file) && listedCandidates.size >= 2000) { candidatesLimited = true; break; }
          listedCandidates.add(file);
          entries.set(file, { mode: match[1]!, type: match[2]!, oid: match[3]!, size: match[4] === '-' ? 0 : Number(match[4]) });
        }
      }
    }
    const moduleFiles = [...entries.keys()].filter((file) => recurse.some((dir) => file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes('/') && /\.ya?ml$/i.test(file)));
    const requested = [...new Set([...files, ...moduleFiles])];
    if (requested.length) {
      const outputs = await batched(requested, ['ls-files', '-z', '--cached', '--full-name'], (args) => readListing(args, '读取 Git 索引失败'));
      for (const bytes of outputs) for (const name of decode(bytes)) if (name.startsWith(prefix)) tracked.add(name.slice(prefix.length));
    }
  }
  // 基线侧展开需求文档目录：递归列出常规 .md blob，并登记进 entries 供后续读取。
  async function listTreeFiles(dir: string): Promise<string[]> {
    let remaining = LIMIT;
    const outputs = await batched([dir], ['ls-tree', '-r', '-z', '-l', '--full-tree', oid], async (args) => {
      let bytes: Buffer;
      try { bytes = await git(root, args, signal, remaining + 1); }
      catch (e) { if (e instanceof ImpactInputError || e instanceof ImpactHostError) throw e; throw new ImpactHostError('读取 Git 目录失败'); }
      remaining -= bytes.length;
      if (remaining < 0) throw new ImpactInputError('Git 清单超过资源上限');
      return bytes;
    });
    const files: string[] = [];
    for (const bytes of outputs) for (const record of decode(bytes)) {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(record);
      if (!match) throw new ImpactHostError('Git 树清单无效');
      const name = match[5]!;
      // 只收常规文件：符号链接（120000）、子模块等一律跳过。
      if (!name.startsWith(prefix) || match[2] !== 'blob' || (match[1] !== '100644' && match[1] !== '100755') || !/\.md$/i.test(name)) continue;
      const file = name.slice(prefix.length);
      entries.set(file, { mode: match[1]!, type: match[2]!, oid: match[3]!, size: match[4] === '-' ? 0 : Number(match[4]) });
      files.push(file);
    }
    return files;
  }
  return { root, oid, entries, tracked, get candidatesLimited() { return candidatesLimited; }, populate, listTreeFiles, async blob(entry: TreeEntry) {
    try { return await git(root, ['cat-file', 'blob', entry.oid], signal, 1024 * 1024 + 1); }
    catch (e) { if (signal?.aborted) throw new ImpactInputError('操作已取消'); if (e instanceof ImpactHostError) throw e; throw new ImpactHostError('读取 Git 对象失败'); }
  } };
}
