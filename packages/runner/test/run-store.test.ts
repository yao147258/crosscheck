import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore, type CaseResult } from '../../core/src/index';
import { RunStore } from '../src/store/run-store';

const time = '2026-11-13T00:00:00.000Z';
const base = { fingerprint: `sha256:${'a'.repeat(64)}`, environment: 'test', selectedCaseIds: ['M-TC-1'] };
function result(runId: string, attempt: number, complete = true) {
  return { runId, caseId: 'M-TC-1', attempt, start: time, end: time,
    budget: { limits: { steps: 10, tokens: 100, minutes: 1 }, used: { steps: 1, tokens: 2, elapsedMs: 3 }, exhausted: false, reason: null },
    complete, status: complete ? 'PASS' as const : 'BLOCKED' as const,
    expectations: complete ? [{ expectationId: 'E1', executor: { expectationId: 'E1', verdict: 'pass' as const, evidenceIds: [], reasoning: '' }, reviewer: { expectationId: 'E1', verdict: 'pass' as const, evidenceIds: [], reasoning: '' }, status: 'PASS' as const }] : [],
    usage: { inputTokens: 1, outputTokens: 2, pricingKnown: false as const, cost: null }, reliability: { attempts: 1, errors: [] }, suggestions: [], drift: [] };
}
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runstore-'));
  const artifacts = new ArtifactStore(dir);
  const run = await RunStore.create(artifacts, base, { password: 'secret', safe: 'ok' });
  return { artifacts, run };
}
describe('运行提交点', () => {
  it('生命周期状态更新持久化，结束状态生成结束时间', async () => {
    const { artifacts, run } = await setup();
    await run.updateStatus('running');
    expect((await RunStore.load(artifacts, run.manifest.runId)).manifest.status).toBe('running');
    await run.updateStatus('completed');
    expect((await RunStore.load(artifacts, run.manifest.runId)).manifest.end).not.toBeNull();
  });
  it('创建不同运行并保存脱敏输入', async () => {
    const { artifacts, run } = await setup();
    const other = await RunStore.create(artifacts, base, {});
    expect(run.manifest.runId).not.toBe(other.manifest.runId);
    expect(await artifacts.readBytes(`runs/${run.manifest.runId}/input.json`).then(x => x?.toString())).not.toContain('secret');
    expect((await RunStore.load(artifacts, run.manifest.runId)).manifest).toEqual(run.manifest);
  });
  it('未提交及中断结果须重跑，完成结果可重建汇总', async () => {
    const { artifacts, run } = await setup();
    const n = await run.nextAttempt('M-TC-1');
    expect(n).toBe(1);
    await artifacts.writeJson(`runs/${run.manifest.runId}/cases/M-TC-1/attempts/1/evidence/index.json`, []);
    expect(await run.listCaseResults()).toEqual([]);
    expect(await run.nextAttempt('M-TC-1')).toBe(2);
    await run.commitCase(result(run.manifest.runId, 2, false), [], []);
    expect(await run.listCaseResults()).toEqual([]);
    expect((await run.rebuildSummary()).status).toBe('BLOCKED');
    expect(await run.nextAttempt('M-TC-1')).toBe(3);
    await run.commitCase(result(run.manifest.runId, 3), [], []);
    expect((await run.listCaseResults())[0]?.attempt).toBe(3);
    const summary = await run.rebuildSummary();
    expect(summary.status).toBe('PASS');
    expect(summary.usage).toEqual({ inputTokens: 1, outputTokens: 2, pricingKnown: false, cost: null });
    expect(summary.budget).toEqual({ steps: 1, tokens: 2, elapsedMs: 3 });
  });
  it('未提交的较新尝试不覆盖先前提交点，但中断结果要求重跑', async () => {
    const { artifacts, run } = await setup();
    await run.commitCase(result(run.manifest.runId, 1), [], []);
    await artifacts.writeBytes(`runs/${run.manifest.runId}/cases/M-TC-1/attempts/2/trace.jsonl`, Buffer.from(''));
    expect((await run.listCaseResults())[0]?.attempt).toBe(1);
    await run.commitCase(result(run.manifest.runId, 2, false), [], []);
    expect(await run.listCaseResults()).toEqual([]);
  });
  it('损坏或归属不匹配的结果不能成为通过结果', async () => {
    const { artifacts, run } = await setup();
    await run.commitCase(result(run.manifest.runId, 1), [], []);
    await artifacts.writeJson(`runs/${run.manifest.runId}/cases/M-TC-1/attempts/1/result.json`, result('other', 1));
    await expect(run.listCaseResults()).rejects.toThrow();
    await writeFile(artifacts.resolve(`runs/${run.manifest.runId}/cases/M-TC-1/attempts/1/result.json`), '{');
    await expect(run.rebuildSummary()).rejects.toThrow();
  });
  it('证据文件内容必须与索引摘要一致，不能读取任意路径', async () => {
    const { artifacts, run } = await setup();
    const prefix = `runs/${run.manifest.runId}/cases/M-TC-1/attempts/1`;
    const evidence = { id: 'e1', type: 'dom' as const, runId: run.manifest.runId, caseId: 'M-TC-1', attempt: 1, actionId: 'a1', phase: 'execution' as const, time, mime: 'text/plain', path: `${prefix}/evidence/files/e1.txt`, digest: `sha256:${createHash('sha256').update('valid').digest('hex')}`, redacted: true };
    await expect(run.commitCase(result(run.manifest.runId, 1), [], [evidence])).rejects.toThrow();
    await artifacts.writeBytes(evidence.path, Buffer.from('tampered'));
    await expect(run.commitCase(result(run.manifest.runId, 1), [], [evidence])).rejects.toThrow();
    await artifacts.writeBytes(evidence.path, Buffer.from('valid'));
    await expect(run.commitCase(result(run.manifest.runId, 1), [], [{ ...evidence, redacted: false }])).rejects.toThrow();
    await run.commitCase(result(run.manifest.runId, 1), [], [evidence]);
    expect((await run.readEvidence('M-TC-1', 1, 'e1')).toString()).toBe('valid');
    await expect(run.readEvidence('M-TC-1', 1, '../../input.json')).rejects.toThrow();
    await artifacts.writeBytes(evidence.path, Buffer.from('tampered'));
    await expect(run.listCaseResults()).rejects.toThrow();
    await expect(run.rebuildSummary()).rejects.toThrow();
    await artifacts.remove(evidence.path);
    await expect(run.listCaseResults()).rejects.toThrow();
    await expect(run.rebuildSummary()).rejects.toThrow();
  });
  it('遵循 JSONL、索引与运行结果的落盘协议', async () => {
    const { artifacts, run } = await setup();
    const prefix = `runs/${run.manifest.runId}/cases/M-TC-1/attempts/1`;
    const trace = [1, 2].map(i => ({ runId: run.manifest.runId, caseId: 'M-TC-1', attempt: 1, actionId: `a${i}`, phase: 'execution' as const, time, event: 'success' as const, message: `事件${i}`, action: { type: 'test', locator: null, input: null }, beforeEvidenceIds: [], afterEvidenceIds: [], result: { status: 'success' as const, output: null, error: null }, durationMs: 0 }));
    await run.commitCase(result(run.manifest.runId, 1), trace, []);
    const lines = (await artifacts.readBytes(`${prefix}/trace.jsonl`))!.toString().trimEnd().split('\n');
    expect(lines.map(line => JSON.parse(line))).toEqual(trace);
    expect(JSON.parse((await artifacts.readBytes(`${prefix}/evidence/index.json`))!.toString())).toEqual([]);
    await run.rebuildSummary();
    expect(JSON.parse((await artifacts.readBytes(`runs/${run.manifest.runId}/results.json`))!.toString()).status).toBe('PASS');
  });
  it('死恢复者可回收，竞争恢复者不能同时进入，活恢复锁不能删除', async () => {
    const { artifacts, run } = await setup();
    const root = `runs/${run.manifest.runId}`;
    await artifacts.writeJson(`${root}/lock.json`, { pid: 2147483647, created: time, token: 'dead-main' });
    await artifacts.writeJson(`${root}/lock-recovery.json`, { pid: 2147483647, created: time, token: 'dead-recovery' });
    let active = 0;
    let max = 0;
    const attempts = await Promise.allSettled(Array.from({ length: 2 }, () => run.withLock(async () => {
      active++; max = Math.max(max, active);
      await new Promise(resolve => setTimeout(resolve, 50));
      active--;
    })));
    expect(attempts.some(x => x.status === 'fulfilled')).toBe(true);
    expect(max).toBe(1);
    await artifacts.writeJson(`${root}/lock.json`, { pid: 2147483647, created: time, token: 'dead-main' });
    const live = { pid: process.pid, created: time, token: 'live' };
    await artifacts.writeJson(`${root}/lock-recovery.json`, live);
    await expect(run.withLock(async () => {})).rejects.toThrow();
    expect(JSON.parse((await artifacts.readBytes(`${root}/lock-recovery.json`))!.toString())).toEqual(live);
  });
  it('最深恢复层已有锁时保守拒绝并保留所有者', async () => {
    const { artifacts, run } = await setup();
    const root = `runs/${run.manifest.runId}`;
    const dead = { pid: 2147483647, created: time, token: 'dead' };
    for (const name of ['lock.json', 'lock-recovery.json', 'lock-recovery-2.json', 'lock-recovery-3.json', 'lock-recovery-4.json']) await artifacts.writeJson(`${root}/${name}`, dead);
    await expect(run.withLock(async () => {})).rejects.toThrow('人工处理');
    expect(JSON.parse((await artifacts.readBytes(`${root}/lock-recovery-4.json`))!.toString())).toEqual(dead);
  });
  it('损坏的 JSONL 不能恢复为通过结果', async () => {
    const { artifacts, run } = await setup();
    await run.commitCase(result(run.manifest.runId, 1), [], []);
    await artifacts.writeBytes(`runs/${run.manifest.runId}/cases/M-TC-1/attempts/1/trace.jsonl`, Buffer.from('{\n'));
    await expect(run.listCaseResults()).rejects.toThrow();
    await expect(run.rebuildSummary()).rejects.toThrow();
  });
  it('判定和轨迹不能引用不存在的证据，索引 ID 不得重复', async () => {
    const { artifacts, run } = await setup();
    const item: CaseResult = result(run.manifest.runId, 1);
    item.expectations[0]!.executor!.evidenceIds = ['missing'];
    await expect(run.commitCase(item, [], [])).rejects.toThrow();
    item.expectations[0]!.executor!.evidenceIds = [];
    const trace = [{ runId: run.manifest.runId, caseId: 'M-TC-1', attempt: 1, actionId: 'a1', phase: 'execution' as const, time, event: 'success' as const, message: '', action: { type: 'test', locator: null, input: null }, beforeEvidenceIds: ['missing'], afterEvidenceIds: [], result: { status: 'success' as const, output: null, error: null }, durationMs: 0 }];
    await expect(run.commitCase(item, trace, [])).rejects.toThrow();
    const bytes = Buffer.from('valid');
    const evidence = { id: 'e1', type: 'dom' as const, runId: run.manifest.runId, caseId: 'M-TC-1', attempt: 1, actionId: 'a1', phase: 'execution' as const, time, mime: 'text/plain', path: `runs/${run.manifest.runId}/cases/M-TC-1/attempts/1/evidence/files/e1.txt`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, redacted: true };
    await artifacts.writeBytes(evidence.path, bytes);
    await expect(run.commitCase(item, [], [evidence, evidence])).rejects.toThrow();
  });
  it('拒绝索引大小写别名及非宿主证据文件名', async () => {
    const { artifacts, run } = await setup();
    const prefix = `runs/${run.manifest.runId}/cases/M-TC-1/attempts/1/evidence`;
    const data = Buffer.from('payload');
    const evidence = { id: 'e1', type: 'dom' as const, runId: run.manifest.runId, caseId: 'M-TC-1', attempt: 1, actionId: 'a1', phase: 'execution' as const, time, mime: 'text/plain', path: `${prefix}/INDEX.JSON`, digest: `sha256:${createHash('sha256').update(data).digest('hex')}`, redacted: true };
    await artifacts.writeBytes(evidence.path, data);
    await expect(run.commitCase(result(run.manifest.runId, 1), [], [evidence])).rejects.toThrow();
    await expect(artifacts.readBytes(`${prefix}/index.json`)).resolves.toEqual(data);
    for (const name of ['files/other.txt', 'files/e1.txt.', 'files/e1.txt ', 'files/e1.txt:stream', 'FILES/e1.txt']) {
      await expect(run.commitCase(result(run.manifest.runId, 1), [], [{ ...evidence, path: `${prefix}/${name}` }])).rejects.toThrow();
    }
  });
  it('证据路径按宿主 ID 和 MIME 映射生成，禁止 DOS 设备名', async () => {
    const { artifacts, run } = await setup();
    const prefix = `runs/${run.manifest.runId}/cases/M-TC-1/attempts/1/evidence/files`;
    const data = Buffer.from('payload');
    const baseEvidence = { id: 'e1', type: 'dom' as const, runId: run.manifest.runId, caseId: 'M-TC-1', attempt: 1, actionId: 'a1', phase: 'execution' as const, time, mime: ' Text/HTML; charset=utf-8 ', path: `${prefix}/e1.txt`, digest: `sha256:${createHash('sha256').update(data).digest('hex')}`, redacted: true };
    await artifacts.writeBytes(baseEvidence.path, data);
    await expect(run.commitCase(result(run.manifest.runId, 1), [], [{ ...baseEvidence, mime: 'image/png' }])).rejects.toThrow();
    await expect(run.commitCase(result(run.manifest.runId, 1), [], [{ ...baseEvidence, mime: 'image/svg+xml' }])).rejects.toThrow();
    await expect(run.commitCase(result(run.manifest.runId, 1), [], [{ ...baseEvidence, id: 'CON', path: `${prefix}/CON.txt` }])).rejects.toThrow();
    await run.commitCase(result(run.manifest.runId, 1), [], [baseEvidence]);
  });
  it('锁拒绝并发，确认死进程锁才回收', async () => {
    const { artifacts, run } = await setup();
    await run.withLock(async () => { await expect(run.withLock(async () => {})).rejects.toThrow(); });
    const lock = `runs/${run.manifest.runId}/lock.json`;
    await artifacts.writeJson(lock, { pid: 2147483647, created: time });
    await run.withLock(async () => {});
    await artifacts.writeJson(lock, { pid: process.pid, created: time });
    await expect(run.withLock(async () => {})).rejects.toThrow();
  });
});
