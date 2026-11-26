import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Config } from '@crosscheck/core';
import { parseModelRef } from './model-ref';
import { conservativeUsageCost, lookupUsagePrice, type UsagePrice } from './usage';

export type UsageNumbers = {
  inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
};

export type UsageEvent = {
  version: 1; id: string; time: string; projectKey: string;
  sessionId: string | null; command: 'chat' | 'init' | 'profile' | 'reqs' | 'plan' | 'run';
  purpose: 'request' | 'compact'; role: 'extractor' | 'planner' | 'executor' | 'reviewer';
  configuredRef: string; provider: string; modelId: string;
  status: 'success' | 'error' | 'cancelled'; usage: UsageNumbers;
  price: UsagePrice | null; cost: number | null;
};

export type UsageAttempt = {
  ref: string; status: UsageEvent['status']; purpose: UsageEvent['purpose'];
  usage: Partial<Record<keyof UsageNumbers, number>> | null;
};
export type UsageObserver = (attempt: UsageAttempt) => void | Promise<void>;
export interface UsageContext { sessionId: string | null; warn: (message: string) => void }
export type UsageBucket = UsageNumbers & { cost: number; calls: number; unknownCalls: number };
export type UsageReport = {
  total: UsageBucket; byCommand: Record<string, UsageBucket>;
  byRole: Record<string, UsageBucket>; byModel: Record<string, UsageBucket>;
  incomplete: boolean; diagnostics: string[];
};
export type UsageObserverOptions = {
  project: string; home?: string; sessionId: string | null;
  command: UsageEvent['command']; role: UsageEvent['role'];
  pricing: Config['pricing']; warn: (message: string) => void;
};

export async function projectUsageLocation(project: string, home?: string): Promise<{ projectKey: string; directory: string }> {
  // 由 realpath 统一路径别名；保留返回的大小写，以隔离大小写敏感目录。
  const canonical = path.normalize(await realpath(path.resolve(project)));
  const projectKey = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { projectKey, directory: path.join(home ?? homedir(), '.crosscheck', 'projects', projectKey, 'usage') };
}

export function makeUsageEvent(options: UsageObserverOptions, projectKey: string, attempt: UsageAttempt): UsageEvent {
  const { provider, modelId } = parseModelRef(attempt.ref);
  const token = (value: number | undefined): number | null =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const usage: UsageNumbers = {
    inputTokens: token(attempt.usage?.inputTokens), outputTokens: token(attempt.usage?.outputTokens),
    cacheReadTokens: token(attempt.usage?.cacheReadTokens), cacheWriteTokens: token(attempt.usage?.cacheWriteTokens),
  };
  const price = lookupUsagePrice(options.pricing, attempt.ref);
  return {
    version: 1, id: randomUUID(), time: new Date().toISOString(), projectKey,
    sessionId: options.sessionId, command: options.command, purpose: attempt.purpose, role: options.role,
    configuredRef: attempt.ref, provider, modelId, status: attempt.status, usage, price,
    cost: conservativeUsageCost(price, usage),
  };
}

export function createUsageObserver(options: UsageObserverOptions): UsageObserver {
  return async attempt => {
    try {
      const { projectKey, directory } = await projectUsageLocation(options.project, options.home);
      const event = makeUsageEvent(options, projectKey, attempt);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `${event.id}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(event), 'utf8'); }
      finally { await file.close(); }
      await rename(temporary, path.join(directory, `${event.id}.json`));
    } catch {
      try { options.warn('用量记录写入失败，本次统计不完整'); } catch { /* 警告不得影响调用结果 */ }
    }
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventFields = [
  'version', 'id', 'time', 'projectKey', 'sessionId', 'command', 'purpose', 'role',
  'configuredRef', 'provider', 'modelId', 'status', 'usage', 'price', 'cost',
] satisfies (keyof UsageEvent)[];
const priceFields = ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok'] satisfies (keyof UsagePrice)[];
const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
const hasOnlyFields = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).every(field => fields.includes(field));
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const token = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

function validUsage(value: unknown): value is UsageNumbers {
  return object(value) && hasOnlyFields(value, tokenFields) && tokenFields.every(field => token(value[field]));
}

function validPrice(value: unknown): value is UsagePrice | null {
  return value === null || (object(value) && hasOnlyFields(value, priceFields)
    && nonnegative(value.inputPerMTok) && nonnegative(value.outputPerMTok)
    && (value.cacheReadPerMTok === undefined || nonnegative(value.cacheReadPerMTok))
    && (value.cacheWritePerMTok === undefined || nonnegative(value.cacheWritePerMTok)));
}

function validEvent(value: unknown, projectKey: string): value is UsageEvent {
  if (!object(value) || !hasOnlyFields(value, eventFields) || value.version !== 1 || typeof value.id !== 'string' || !uuid.test(value.id)
    || typeof value.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.time)
    || !Number.isFinite(Date.parse(value.time)) || new Date(value.time).toISOString() !== value.time
    || value.projectKey !== projectKey || !/^[0-9a-f]{64}$/.test(projectKey)
    || !(value.sessionId === null || (typeof value.sessionId === 'string' && value.sessionId.length > 0))
    || !['chat', 'init', 'profile', 'reqs', 'plan', 'run'].includes(value.command as string)
    || !['request', 'compact'].includes(value.purpose as string)
    || !['extractor', 'planner', 'executor', 'reviewer'].includes(value.role as string)
    || !['success', 'error', 'cancelled'].includes(value.status as string)
    || typeof value.configuredRef !== 'string' || typeof value.provider !== 'string' || typeof value.modelId !== 'string'
    || !value.provider || !value.modelId || !validUsage(value.usage) || !validPrice(value.price)
    || value.cost !== conservativeUsageCost(value.price, value.usage)) return false;
  try {
    const parsed = parseModelRef(value.configuredRef);
    if (parsed.provider !== value.provider || parsed.modelId !== value.modelId) return false;
  } catch { return false; }
  return true;
}

function emptyBucket(): UsageBucket {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, calls: 0, unknownCalls: 0 };
}

function addEvent(bucket: UsageBucket, event: UsageEvent): void {
  bucket.calls++;
  for (const field of tokenFields) bucket[field] = (bucket[field] ?? 0) + (event.usage[field] ?? 0);
  bucket.cost += event.cost ?? 0;
  if (event.price === null || event.cost === null || tokenFields.some(field => event.usage[field] === null)) bucket.unknownCalls++;
}

export async function readUsage(options: { project: string; home?: string; sessionId?: string }): Promise<UsageReport> {
  const report: UsageReport = { total: emptyBucket(), byCommand: Object.create(null), byRole: Object.create(null), byModel: Object.create(null), incomplete: false, diagnostics: [] };
  const diagnostic = (message: string) => { report.incomplete = true; report.diagnostics.push(message); };
  let location: { projectKey: string; directory: string };
  try { location = await projectUsageLocation(options.project, options.home); }
  catch { diagnostic('无法定位用量账本'); return report; }
  let files: string[];
  try { files = await readdir(location.directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostic('无法读取用量账本');
    else {
      let parent = path.dirname(location.directory);
      for (;;) {
        try {
          if (!(await stat(parent)).isDirectory()) diagnostic('无法读取用量账本');
          break;
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') { diagnostic('无法读取用量账本'); break; }
          const next = path.dirname(parent);
          if (next === parent) { diagnostic('无法读取用量账本'); break; }
          parent = next;
        }
      }
    }
    return report;
  }
  for (const filename of files) {
    if (filename.endsWith('.tmp')) { diagnostic('存在未完成的用量记录'); continue; }
    if (!filename.endsWith('.json')) continue;
    let event: unknown;
    try { event = JSON.parse(await readFile(path.join(location.directory, filename), 'utf8')); }
    catch { diagnostic('无法读取用量记录'); continue; }
    if (!validEvent(event, location.projectKey) || filename !== `${event.id}.json`) { diagnostic('用量记录格式无效'); continue; }
    if (options.sessionId !== undefined && event.sessionId !== options.sessionId) continue;
    addEvent(report.total, event);
    for (const [groups, key] of [[report.byCommand, event.command], [report.byRole, event.role], [report.byModel, `${event.provider}:${event.modelId}`]] as const) {
      addEvent(groups[key] ??= emptyBucket(), event);
    }
  }
  return report;
}
