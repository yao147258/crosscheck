import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { ModuleCasesSchema, ModuleClausesSchema, NotesTextSchema, decodeNotesUtf8, PROFILE_FILES, PROFILE_SCHEMAS, ProfileSchema, ProjectConfigSchema, type ImpactSnapshot } from '@crosscheck/core';
import { isSafeProjectPath } from '@crosscheck/discovery';
import { ImpactHostError, ImpactInputError, openBaseline } from './git';
export { ImpactHostError, ImpactInputError } from './git';

const MAX_FILE = 1024 * 1024, MAX_TOTAL = 16 * MAX_FILE, MAX_DOCS = 2 * MAX_FILE, MAX_FILES = 2000;
const config = '.crosscheck/config.yaml', notes = '.crosscheck/notes.md';
const profiles = PROFILE_FILES.map((name) => `.crosscheck/system/${name}`);
const dirs = ['.crosscheck/requirements', '.crosscheck/cases'];
const validPath = isSafeProjectPath;
const normalize = (file: string) => file.replaceAll('\\', '/').split('/').filter((p) => p && p !== '.').join('/');
type ReadResult = { state: 'present'; bytes: Buffer } | { state: 'missing' | 'invalid' };

export async function loadImpactSnapshots(project: string, since: string, signal?: AbortSignal, options?: { beforeRecheck?: () => Promise<void> }): Promise<{ baseline: string; base: ImpactSnapshot; current: ImpactSnapshot }> {
  const git = await openBaseline(project, since, signal);
  await git.populate([config, notes, ...profiles], dirs);
  const base: ImpactSnapshot = { nodes: [], files: [], diagnostics: [] }, current: ImpactSnapshot = { nodes: [], files: [], diagnostics: [] };
  const cache = new Map<string, ReadResult>();
  const blobs = new Map<string, Buffer>();
  const profileValues = { base: {} as Record<string, unknown>, current: {} as Record<string, unknown> };
  const signatures = new Map<string, string>();
  const budgets = { base: { total: 0, docs: 0 }, current: { total: 0, docs: 0 } };
  // 两侧读取同一有界候选并集；missing/invalid 也占名额，缓存命中不重复计数。
  const candidates = new Set([config, notes, ...profiles]);
  const documentCounted = { base: new Set<string>(), current: new Set<string>() };
  const declaredDocs = { base: new Set<string>(), current: new Set<string>() };
  const fileLimit = () => {
    for (const snap of [base, current]) if (!snap.diagnostics.some((d) => d.code === 'file-limit')) snap.diagnostics.push({ code: 'file-limit', message: '两侧相关文件候选并集超过 2000 个上限，未检查范围无法确认' });
  };
  if (git.candidatesLimited) {
    fileLimit();
    for (const snap of [base, current]) for (const dir of dirs) snap.files.push({ file: dir, state: 'invalid' });
  }
  const admit = (file: string) => {
    if (candidates.has(file)) return true;
    if (candidates.size >= MAX_FILES) { fileLimit(); return false; }
    candidates.add(file); return true;
  };
  const diag = (snap: ImpactSnapshot, code: string, file: string, message: string) => snap.diagnostics.push({ code, file, message });
  const abort = () => { if (signal?.aborted) throw new ImpactInputError('操作已取消'); };
  const checked = async (file: string): Promise<'missing' | 'safe' | 'invalid'> => {
    let cursor = git.root;
    const parts = file.split('/');
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      try { const stat = await lstat(cursor); if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) return 'invalid'; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') return 'invalid'; throw new ImpactHostError('项目文件读取失败'); }
    }
    return 'safe';
  };
  const readCurrent = async (file: string, limit = MAX_FILE): Promise<ReadResult> => {
    abort(); if (!validPath(file)) return { state: 'invalid' };
    const status = await checked(file); if (status !== 'safe') return { state: status };
    let handle;
    try {
      handle = await open(path.join(git.root, ...file.split('/')), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) return { state: 'invalid' };
      const buffer = Buffer.alloc(limit + 1); let offset = 0;
      while (offset < buffer.length) { abort(); const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
      if (offset > limit) return { state: 'invalid' };
      return { state: 'present', bytes: buffer.subarray(0, offset) };
    } catch (e) { if (e instanceof ImpactInputError) throw e; if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }; if (['ELOOP', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return { state: 'invalid' }; throw new ImpactHostError('项目文件读取失败'); }
    finally { await handle?.close(); }
  };
  const raw = async (side: 'base' | 'current', file: string, document = false): Promise<ReadResult> => {
    const key = `${side}\0${file}`; const previous = cache.get(key);
    const snapshot = side === 'base' ? base : current; const budget = budgets[side];
    if (previous) {
      if (document && previous.state === 'present' && !documentCounted[side].has(file)) {
        documentCounted[side].add(file);
        if (budget.docs + previous.bytes.length > MAX_DOCS) { diag(snapshot, 'restricted-input', file, '需求文档超过资源上限'); return { state: 'invalid' }; }
        budget.docs += previous.bytes.length;
      }
      return previous;
    }
    let result: ReadResult;
    const limit = Math.max(0, Math.min(MAX_FILE, MAX_TOTAL - budget.total, document ? MAX_DOCS - budget.docs : MAX_FILE));
    if (!validPath(file) || !candidates.has(file) || (side === 'current' && dirs.some((dir) => file.startsWith(`${dir}/`) && ['overflow', 'invalid'].includes(signatures.get(dir) ?? '')))) result = { state: 'invalid' };
    else if (side === 'current') result = await readCurrent(file, limit);
    else {
      const parts = file.split('/'); const unsafe = parts.some((_, i) => { const entry = git.entries.get(parts.slice(0, i + 1).join('/')); return entry && (i < parts.length - 1 ? entry.type !== 'tree' : entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')); });
      const entry = git.entries.get(file);
      if (unsafe || git.entries.has('')) result = { state: 'invalid' };
      else if (!entry) result = { state: 'missing' };
      else if (entry.size > limit) result = { state: 'invalid' };
      else {
        let bytes = blobs.get(entry.oid);
        if (!bytes) { bytes = await git.blob(entry); blobs.set(entry.oid, bytes); }
        result = bytes.length === entry.size ? { state: 'present', bytes } : { state: 'invalid' };
      }
    }
    if (result.state === 'present') {
      budget.total += result.bytes.length;
      if (document) { budget.docs += result.bytes.length; documentCounted[side].add(file); }
      if (budget.total > MAX_TOTAL || budget.docs > MAX_DOCS) result = { state: 'invalid' };
    }
    if (result.state === 'invalid') diag(snapshot, 'restricted-input', file, '路径不安全或资源超限');
    cache.set(key, result); return result;
  };
  const list = async (dir: string): Promise<string[]> => {
    const state = await checked(dir); if (state === 'missing') { signatures.set(dir, 'missing'); return []; }
    if (state === 'invalid') { signatures.set(dir, 'invalid'); diag(current, 'restricted-input', dir, '目录不安全'); return []; }
    try {
      const names: string[] = [];
      const directory = await opendir(path.join(git.root, ...dir.split('/')));
      for await (const entry of directory) {
        abort();
        if (names.length >= MAX_FILES) { diag(current, 'restricted-input', dir, '目录条目超过上限'); signatures.set(dir, 'overflow'); return []; }
        names.push(entry.name);
      }
      names.sort(); signatures.set(dir, JSON.stringify(names));
      return names.filter((name) => /\.ya?ml$/i.test(name)).map((name) => `${dir}/${name}`);
    } catch (e) {
      if (e instanceof ImpactInputError) throw e;
      if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') { signatures.set(dir, 'invalid'); diag(current, 'restricted-input', dir, '目录不是普通目录'); return []; }
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { signatures.set(dir, 'missing'); return []; }
      throw new ImpactHostError('项目目录读取失败');
    }
  };
  for (const dir of dirs) {
    const parts = dir.split('/');
    const unsafe = parts.some((_, i) => {
      const entry = git.entries.get(parts.slice(0, i + 1).join('/'));
      return entry !== undefined && entry.type !== 'tree';
    });
    if (unsafe) { base.files.push({ file: dir, state: 'invalid' }); diag(base, 'restricted-input', dir, '基线目录不安全'); }
  }
  const currentModules = (await Promise.all(dirs.map(list))).flat();
  for (const dir of dirs) if (['invalid', 'overflow'].includes(signatures.get(dir) ?? '')) current.files.push({ file: dir, state: 'invalid' });
  const baseModules = [...git.entries.keys()].filter((file) => dirs.some((dir) => file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes('/') && /\.ya?ml$/i.test(file)));
  const modules = [...new Set([...currentModules, ...baseModules])].sort().filter((file) => admit(file));
  if (currentModules.length + baseModules.length > modules.length) for (const snap of [base, current]) if (snap.diagnostics.some((d) => d.code === 'file-limit')) {
    for (const dir of dirs) if (!snap.files.some((f) => f.file === dir)) snap.files.push({ file: dir, state: 'invalid' });
  }
  await git.populate(modules);
  const parse = async (side: 'base' | 'current', file: string, kind: 'config' | 'notes' | 'document' | 'profile' | 'module') => {
    const snap = side === 'base' ? base : current; const result = await raw(side, file, kind === 'document');
    let state: 'present' | 'missing' | 'invalid' = result.state;
    const nodeStart = snap.nodes.length;
    if (result.state === 'present') {
      try {
        const text = kind === 'notes' ? decodeNotesUtf8(result.bytes) : new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
        if (kind === 'document' || kind === 'notes') {
          if (kind === 'notes' && !NotesTextSchema.safeParse(text).success) throw new Error();
          snap.nodes.push({ kind, key: kind === 'notes' ? 'notes:project' : `document:${file}`, file, value: text });
        } else {
          const data = YAML.parse(text) ?? null;
          if (kind === 'config') {
            const parsed = ProjectConfigSchema.parse(data); snap.nodes.push({ kind, key: 'config:project', file, value: parsed });
          } else if (kind === 'profile') {
            const name = file.split('/').pop() as typeof PROFILE_FILES[number];
            const parsed = PROFILE_SCHEMAS[name].parse(data) as Record<string, unknown>;
            profileValues[side][name] = parsed;
            const prop: Record<string, string> = { 'environments.yaml': 'environments', 'auth.yaml': 'actors', 'api-catalog.yaml': 'operations', 'pages.yaml': 'pages', 'data-model.yaml': 'queries', 'fixtures.yaml': 'fixtures' };
            if (name === 'guardrails.yaml') snap.nodes.push({ kind, key: `profile:${name}:global`, file, id: 'global', value: parsed });
            else {
              if (name === 'data-model.yaml' && parsed.connection) snap.nodes.push({ kind, key: `profile:${name}:$connection`, file, id: '$connection', value: parsed.connection });
              for (const [id, value] of Object.entries(parsed[prop[name]!] as Record<string, unknown>)) snap.nodes.push({ kind, key: `profile:${name}:${id}`, file, id, value });
            }
          } else {
            const clause = file.startsWith(`${dirs[0]}/`); const values = clause ? ModuleClausesSchema.parse(data) : ModuleCasesSchema.parse(data);
            const module = path.posix.basename(file).replace(/\.ya?ml$/i, '');
            if (!/^[A-Za-z0-9_]+$/.test(module) || values.some((v) => v.id.split('-')[0] !== module)) throw new Error();
            for (const value of values) { const k = clause ? 'clause' : 'case'; snap.nodes.push({ kind: k, key: `${k}:${value.id}`, id: value.id, file, value }); }
          }
        }
      } catch { snap.nodes.splice(nodeStart); state = 'invalid'; diag(snap, 'invalid-file', file, '文件编码、格式或内容无效'); }
    }
    if (kind === 'document' && state === 'missing') {
      if (declaredDocs[side].has(file)) diag(snap, 'missing-document', file, '登记的需求文档不存在');
    }
    snap.files.push({ file, state });
  };
  for (const side of ['base', 'current'] as const) await parse(side, config, 'config');
  const docs = new Set<string>();
  for (const side of ['base', 'current'] as const) {
    const snap = side === 'base' ? base : current;
    const value = snap.nodes.find((n) => n.kind === 'config')?.value as { requirementsDocs?: string[] } | undefined;
    for (const file of value?.requirementsDocs ?? []) {
      if (!validPath(file)) {
        if (snap.diagnostics.length >= MAX_FILES) { fileLimit(); break; }
        diag(snap, 'restricted-input', '', '需求文档路径不安全'); continue;
      }
      const normalized = normalize(file);
      if (!normalized) { diag(snap, 'restricted-input', '', '需求文档路径不安全'); continue; }
      if (!admit(normalized)) break;
      declaredDocs[side].add(normalized); docs.add(normalized);
    }
  }
  await git.populate([...docs]);
  for (const side of ['base', 'current'] as const) {
    const snap = side === 'base' ? base : current;
    if (snap.files.find((f) => f.file === config)?.state === 'missing') diag(snap, 'missing-config', config, '项目配置不存在');
    for (const file of [...docs].sort()) await parse(side, file, 'document');
    await parse(side, notes, 'notes');
    for (const file of profiles) await parse(side, file, 'profile');
    if (profiles.every((file) => snap.files.some((f) => f.file === file && f.state === 'present')) && !ProfileSchema.safeParse(profileValues[side]).success) {
      snap.diagnostics.push({ code: 'invalid-profile', message: '七画像跨文件校验失败，请复核引用、参数及连接配置' });
    }
    for (const file of modules) await parse(side, file, 'module');
    for (const file of [notes, ...profiles]) if (snap.files.find((f) => f.file === file)?.state === 'missing') diag(snap, 'missing-artifact', file, '工件不存在，分析范围不完整');
    const keys = new Set<string>(); for (const node of snap.nodes) { if (keys.has(node.key)) diag(snap, 'duplicate-id', node.file, '实体标识重复'); keys.add(node.key); }
  }
  await options?.beforeRecheck?.();
  for (const [key, original] of cache) {
    // 仅对成功读取的文件比较完整字节；无效文件不声称做了内容比对。
    if (!key.startsWith('current\0')) continue;
    const file = key.slice(8); const now = original.state === 'present' ? await readCurrent(file, original.bytes.length) : await readCurrent(file, 0);
    if (original.state !== now.state || (original.state === 'present' && now.state === 'present' && !original.bytes.equals(now.bytes))) {
      diag(current, 'concurrent-change', file, '读取期间文件发生变化');
      for (const item of current.files) if (item.file === file) item.state = 'invalid';
      current.nodes = current.nodes.filter((node) => node.file !== file);
    }
    if (original.state === 'present' && !git.entries.has(file) && !git.tracked.has(file)) diag(base, 'history-incomplete', file, '当前文件没有基线历史，可能未跟踪或被忽略');
  }
  for (const [dir, signature] of [...signatures]) {
    const before = signature; signatures.delete(dir); await list(dir);
    const after = signatures.get(dir);
    if (after !== before) {
      diag(current, 'concurrent-change', dir, '读取期间目录发生变化');
      if (!current.files.some((file) => file.file === dir && file.state === 'invalid')) current.files.push({ file: dir, state: 'invalid' });
    }
  }
  return { baseline: git.oid, base, current };
}
