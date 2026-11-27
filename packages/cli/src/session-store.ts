import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters, TextDecoder } from 'node:util';
import { projectUsageLocation } from '@crosscheck/models';

export type SessionEntry =
  | { kind: 'begin'; operation: 'chat' | 'slash'; input: string }
  | { kind: 'end'; begin: number; status: 'success' | 'error' | 'cancelled'; output: string; reply?: string };
export type SessionRecordedEntry = SessionEntry & { revision: number; time: string };
export type SessionMessage = { role: 'user' | 'assistant'; content: string };
export type SessionSnapshot = {
  id: string;
  revision: number;
  createdAt: string | null;
  updatedAt: string | null;
  entries: SessionRecordedEntry[];
  history: SessionMessage[];
  unfinishedBegins: number[];
  diagnostics: string[];
  readonly: boolean;
};
export type SessionListItem = Pick<SessionSnapshot, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'diagnostics' | 'readonly'>
  & { preview: string };

export class SessionStoreError extends Error {
  constructor(public readonly code: 'invalid-id' | 'invalid-entry' | 'conflict' | 'readonly' | 'unreadable', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionStoreError';
  }
}

type RecordV1 = { version: 1; id: string; projectKey: string; revision: number; time: string; entry: SessionEntry };
type Location = { directory: string; projectKey: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const outputLimit = 64 * 1024;
const truncation = '\n[输出已截断]';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function canonicalId(id: string): string {
  if (typeof id !== 'string' || !uuid.test(id.toLowerCase())) throw new SessionStoreError('invalid-id', '会话 ID 必须是 UUID');
  return id.toLowerCase();
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key));
}

function isEntry(value: unknown): value is SessionEntry {
  if (!object(value)) return false;
  if (value.kind === 'begin') {
    return onlyFields(value, ['kind', 'operation', 'input'])
      && (value.operation === 'chat' || value.operation === 'slash') && typeof value.input === 'string';
  }
  return value.kind === 'end' && onlyFields(value, ['kind', 'begin', 'status', 'output', 'reply'])
    && typeof value.begin === 'number' && Number.isSafeInteger(value.begin) && value.begin > 0
    && (value.status === 'success' || value.status === 'error' || value.status === 'cancelled')
    && typeof value.output === 'string' && (value.reply === undefined || typeof value.reply === 'string');
}

function canFollow(entry: SessionEntry, previous: SessionRecordedEntry | undefined): boolean {
  if (entry.kind === 'begin') return true;
  // 只有最近且仍开放的操作能接收结束记录；新的开始不会修改此前未完成的记录。
  return previous?.kind === 'begin' && entry.begin === previous.revision
    && (typeof entry.reply === 'string') === (previous.operation === 'chat' && entry.status === 'success');
}

function isRecord(value: unknown, projectKey: string, id: string, revision: number): value is RecordV1 {
  return object(value) && onlyFields(value, ['version', 'id', 'projectKey', 'revision', 'time', 'entry'])
    && value.version === 1 && value.id === id && value.projectKey === projectKey && value.revision === revision
    && typeof value.time === 'string' && timestamp.test(value.time) && Number.isFinite(Date.parse(value.time))
    && new Date(value.time).toISOString() === value.time && isEntry(value.entry)
    && (value.entry.kind === 'begin' || Buffer.byteLength(value.entry.output) <= outputLimit);
}

// v1 字节格式为固定字段顺序的紧凑 JSON（UTF-8，无 BOM、无额外空白或换行）。
function encodeRecord({ version, id, projectKey, revision, time, entry }: RecordV1): string {
  const body = entry.kind === 'begin'
    ? { kind: entry.kind, operation: entry.operation, input: entry.input }
    : { kind: entry.kind, begin: entry.begin, status: entry.status, output: entry.output, reply: entry.reply };
  return JSON.stringify({ version, id, projectKey, revision, time, entry: body });
}

function truncateOutput(output: string): string {
  const bytes = Buffer.from(output, 'utf8');
  if (bytes.length <= outputLimit) return output;
  let end = outputLimit - Buffer.byteLength(truncation);
  // 若切点落在 UTF-8 续字节上，回退到该字符的首字节之前。
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.toString('utf8', 0, end) + truncation;
}

function preview(input: string): string {
  const normalized = stripVTControlCharacters(input).replace(/[\p{White_Space}\p{Cc}\p{Cf}]+/gu, ' ').trim();
  const characters: string[] = [];
  for (const character of normalized) {
    if (characters.length === 120) {
      characters[119] = '…';
      break;
    }
    characters.push(character);
  }
  return characters.join('');
}

function emptySnapshot(id: string): SessionSnapshot {
  return { id, revision: 0, createdAt: null, updatedAt: null, entries: [], history: [], unfinishedBegins: [], diagnostics: [], readonly: false };
}

function applyRecord(snapshot: SessionSnapshot, { entry, revision, time }: RecordV1): void {
  const previous = snapshot.entries.at(-1);
  snapshot.entries.push({ ...entry, revision, time });
  snapshot.revision = revision;
  snapshot.createdAt ??= time;
  snapshot.updatedAt = time;
  if (entry.kind === 'begin') snapshot.unfinishedBegins.push(revision);
  else {
    snapshot.unfinishedBegins.pop();
    if (previous?.kind === 'begin' && entry.reply !== undefined) {
      snapshot.history.push({ role: 'user', content: previous.input }, { role: 'assistant', content: entry.reply });
    }
  }
}

function diagnose(snapshot: SessionSnapshot, message: string): SessionSnapshot {
  snapshot.readonly = true;
  snapshot.diagnostics.push(message);
  return snapshot;
}

async function readSession(location: Location, id: string): Promise<SessionSnapshot | null> {
  const directory = path.join(location.directory, id);
  const snapshot = emptySnapshot(id);
  let names: string[];
  try {
    if (!(await lstat(directory)).isDirectory()) return diagnose(snapshot, '会话路径不是普通目录');
    names = await readdir(directory);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw new SessionStoreError('unreadable', '无法读取会话目录', { cause: error });
  }
  const revisions: number[] = [];
  let staging = false;
  for (const name of names) {
    if (name.endsWith('.tmp') && uuid.test(name.slice(0, -4))) { staging = true; continue; }
    const match = /^([1-9]\d*)\.json$/.exec(name);
    const revision = Number(match?.[1]);
    if (Number.isSafeInteger(revision)) revisions.push(revision);
    else if (!snapshot.readonly) diagnose(snapshot, '会话目录包含无法识别的文件名');
  }
  if (staging) snapshot.diagnostics.push('发现未提交的暂存文件（可能正在写入或异常残留），未读取其内容');
  revisions.sort((left, right) => left - right);
  for (const revision of revisions) {
    const expected = snapshot.revision + 1;
    if (revision !== expected) return diagnose(snapshot, `缺少会话修订 ${expected}`);
    const filename = path.join(directory, `${revision}.json`);
    try {
      if (!(await lstat(filename)).isFile()) return diagnose(snapshot, `会话修订 ${revision} 不是普通文件`);
      const text = utf8.decode(await readFile(filename));
      const record: unknown = JSON.parse(text);
      // 仅检查解析结果会漏掉重复键；规范重编码必须与原文完全一致。
      if (!isRecord(record, location.projectKey, id, revision) || encodeRecord(record) !== text
        || !canFollow(record.entry, snapshot.entries.at(-1))) {
        return diagnose(snapshot, `会话修订 ${revision} 无效`);
      }
      applyRecord(snapshot, record);
    } catch {
      return diagnose(snapshot, `无法读取会话修订 ${revision}`);
    }
  }
  return snapshot.revision > 0 || snapshot.diagnostics.length > 0 ? snapshot : null;
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows 上 Node 能打开目录，但对目录执行 fsync 会返回 EPERM。
  if (platform() === 'win32') return;
  try {
    const handle = await open(directory, 'r');
    try { await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    // 某些文件系统不提供目录同步；其他失败（如 EIO）不能冒充不支持。
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].some(code => hasCode(error, code))) throw error;
  }
}

async function commitRecord(directory: string, record: RecordV1, warn?: (message: string) => void): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let ancestorSyncLimited = false;
  if (platform() !== 'win32' && record.revision === 1) {
    // 其他进程可能刚创建目录就退出；目录或修订可见并不证明祖先已同步。
    // 首次追加由下向上同步至根目录。路径含符号链接时，同时同步实际目标和入口的祖先。
    const resolved = await realpath(directory);
    const synced = new Set<string>();
    for (const start of [resolved, directory]) {
      for (let parent = path.dirname(start); !synced.has(parent); parent = path.dirname(parent)) {
        try { await syncDirectory(parent); }
        catch (error) {
          // POSIX 允许穿越无读权限的祖先；不能为同步额外要求祖先目录的读权限。
          if (!hasCode(error, 'EACCES') && !hasCode(error, 'EPERM')) throw error;
          ancestorSyncLimited = true;
        }
        synced.add(parent);
      }
    }
  }
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(encodeRecord(record), 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    // 检查修订只能提前发现冲突；真正的提交点是不会覆盖目标的硬链接。
    try {
      await link(temporary, path.join(directory, `${record.revision}.json`));
    } catch (error) {
      if (hasCode(error, 'EEXIST')) throw new SessionStoreError('conflict', '会话版本冲突，请重新加载');
      throw error;
    }
  } finally {
    // 链接成功后即已提交，清理失败不应改变结果；读取方会忽略暂存名。
    await unlink(temporary).catch(() => undefined);
  }
  // 硬链接已可见，不能把目录同步失败当成追加失败，否则调用方重试会发生版本冲突。
  let directorySyncFailed = false;
  try { await syncDirectory(directory); } catch { directorySyncFailed = true; }
  const warnings: string[] = [];
  if (ancestorSyncLimited) warnings.push('会话修订已提交，但无权限同步部分祖先目录；系统异常时可能丢失本次记录');
  if (directorySyncFailed) warnings.push('会话修订已提交，但目录同步失败；系统异常时可能丢失本次记录');
  for (const warning of warnings) {
    try { warn?.(warning); } catch { /* 告警失败不得改变已提交的结果。 */ }
  }
}

export class SessionStore {
  private location?: Promise<Location>;

  constructor(private readonly project: string, private readonly home?: string) {}

  private locate(): Promise<Location> {
    // 同一实例共享首次解析，成功后固定项目身份；失败则允许下次重试。
    return this.location ??= projectUsageLocation(this.project, this.home)
      .then(({ directory, projectKey }) => ({ directory: path.resolve(directory, '..', 'sessions'), projectKey }))
      .catch(error => {
        this.location = undefined;
        throw error;
      });
  }

  async load(id: string): Promise<SessionSnapshot | null> {
    const canonical = canonicalId(id);
    return readSession(await this.locate(), canonical);
  }

  async list(): Promise<SessionListItem[]> {
    const location = await this.locate();
    let names: string[];
    try {
      names = await readdir(location.directory);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }
    const items: SessionListItem[] = [];
    for (const id of names) {
      if (!uuid.test(id)) continue;
      let snapshot: SessionSnapshot | null;
      try { snapshot = await readSession(location, id); }
      catch (error) {
        if (!(error instanceof SessionStoreError) || error.code !== 'unreadable') throw error;
        // 列表仍显示不可读项的诊断，但 load 不返回可激活的空快照。
        snapshot = diagnose(emptySnapshot(id), error.message);
      }
      if (snapshot === null) continue;
      const { revision, createdAt, updatedAt, entries, diagnostics, readonly } = snapshot;
      const first = entries[0];
      items.push({ id, revision, createdAt, updatedAt, diagnostics, readonly, preview: first?.kind === 'begin' ? preview(first.input) : '' });
    }
    return items.sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') || left.id.localeCompare(right.id));
  }

  async append(id: string, revision: number, entry: SessionEntry, warn?: (message: string) => void): Promise<SessionSnapshot> {
    const canonical = canonicalId(id);
    if (!isEntry(entry)) throw new SessionStoreError('invalid-entry', '会话记录格式无效');
    // 固定本次追加的值，避免等待 I/O 时调用方修改原对象。
    const stored: SessionEntry = entry.kind === 'begin'
      ? { kind: 'begin', operation: entry.operation, input: entry.input }
      : { kind: 'end', begin: entry.begin, status: entry.status, output: truncateOutput(entry.output),
          ...(entry.reply === undefined ? {} : { reply: entry.reply }) };
    const location = await this.locate();
    const snapshot = (await readSession(location, canonical)) ?? emptySnapshot(canonical);
    if (snapshot.readonly) throw new SessionStoreError('readonly', `会话记录损坏，只读：${snapshot.diagnostics.join('；')}`);
    if (snapshot.revision !== revision) throw new SessionStoreError('conflict', '会话版本冲突，请重新加载');
    if (!canFollow(stored, snapshot.entries.at(-1))) throw new SessionStoreError('invalid-entry', '结束记录不符合当前会话操作');
    const record: RecordV1 = { version: 1, id: canonical, projectKey: location.projectKey, revision: revision + 1,
      time: new Date().toISOString(), entry: stored };
    await commitRecord(path.join(location.directory, canonical), record, warn);
    applyRecord(snapshot, record);
    return snapshot;
  }
}
