import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Approvals, DispositionsFileSchema, evidencePath, type EvidenceRecord } from '@crosscheck/core';
import { RunStore } from '@crosscheck/runner';
import {
  DECISION_LABELS, exportEvidence, extensionFor, listRuns, loadHomeSummary, loadResultRows,
  recordDisposition, revokeClause,
} from '../src/index';
import { cleanupProjects, clause, createProject } from './fixture';
import { createFailedRun } from './run-fixture';

afterEach(async () => { vi.restoreAllMocks(); await cleanupProjects(); });
const bug = { caseId: 'M-TC-1', expectationId: 'E1', decision: 'confirmed_bug' as const, note: '' };
const issue = { ...bug, decision: 'clause_issue' as const, clauseId: 'M-AC-2' };
const dispositions = (project: Awaited<ReturnType<typeof createProject>>, runId: string) => project.artifacts.readJson(`runs/${runId}/dispositions.json`, DispositionsFileSchema);
const unlocked = async (project: Awaited<ReturnType<typeof createProject>>, runId: string) => {
  expect(await project.artifacts.readBytes(`runs/${runId}/lock.json`)).toBeUndefined();
  await project.session.mutate(() => {});
};

describe('历史结果与首页', () => {
  it('读取真实历史 FAIL/DISPUTED、双方理由和证据，不依赖当前用例', async () => {
    const { project, runId, result } = await createFailedRun();
    expect(result.cases[0]?.expectations.map((e) => e.status)).toEqual(['FAIL', 'DISPUTED', 'PASS']);
    await project.artifacts.saveCases('M', []);
    const rows = await loadResultRows(project.session, runId);
    expect(rows.map((r) => [r.expectationId, r.status, r.expectationText])).toEqual([['E1', 'FAIL', '值为 ok'], ['E2', 'DISPUTED', '状态为 200']]);
    expect(rows[1]).toMatchObject({ executor: { verdict: 'pass', reasoning: '执行方理由' }, reviewer: { verdict: 'fail', reasoning: '复核方理由' }, covers: ['M-AC-1', 'M-AC-2'], attempt: 1 });
    expect(rows[0]!.evidence.length).toBeGreaterThan(0);
    expect(DECISION_LABELS.false_positive).toBe('误报');
  });

  it('运行列表仅保留合法名称并按时间倒序，空目录返回空', async () => {
    const project = await createProject();
    expect(await listRuns(project.session)).toEqual([]);
    const old = '20260101T000000000Z-' + 'a'.repeat(32);
    const recent = '20261116T000000000Z-' + 'b'.repeat(32);
    for (const id of [old, recent, '坏目录']) await project.artifacts.writeJson(`runs/${id}/manifest.json`, {});
    expect(await listRuns(project.session)).toEqual([recent, old]);
  });

  it('历史展示摘要损坏时拒绝加载和裁决，不落盘', async () => {
    const { project, runId } = await createFailedRun();
    const rel = `runs/${runId}/input.json`;
    const snapshot = JSON.parse((await project.artifacts.readBytes(rel))!.toString());
    snapshot.display.cases[0].expectations[0].text = '篡改';
    await project.artifacts.writeJson(rel, snapshot);
    await expect(loadResultRows(project.session, runId)).rejects.toThrow('快照');
    await expect(recordDisposition(project.session, runId, bug)).rejects.toThrow('快照');
    expect(await dispositions(project, runId)).toBeUndefined();
    await unlocked(project, runId);
  });

  it('首页采用用例 overview 的动态 stale；撤销条款也计为用例待处理', async () => {
    const { project } = await createFailedRun();
    expect(await loadHomeSummary(project.session)).toEqual({ profilePending: 0, clausesPending: 0, casesPending: 0, runs: 1 });
    await revokeClause(project.session, 'M', 'M-AC-1');
    expect(await loadHomeSummary(project.session)).toEqual({ profilePending: 0, clausesPending: 1, casesPending: 1, runs: 1 });
    await project.artifacts.remove('system/pages.yaml');
    await project.artifacts.saveClauses('M', [clause(1, { status: 'unclear' }), clause(2), clause(3)]);
    expect(await loadHomeSummary(project.session)).toEqual({ profilePending: 1, clausesPending: 1, casesPending: 1, runs: 1 });
  });
});

describe('人工裁决边界与故障', () => {
  it('合法裁决持久化、重复 upsert、记录人时间及加载回显', async () => {
    const { project, runId } = await createFailedRun();
    await recordDisposition(project.session, runId, bug);
    const now = new Date('2026-11-16T10:00:00.000Z');
    expect(await recordDisposition(project.session, runId, { ...bug, decision: 'false_positive', note: '环境问题' }, now)).toContain('误报');
    expect((await dispositions(project, runId))?.items).toEqual([{ ...bug, decision: 'false_positive', note: '环境问题', by: '测试人', at: now.toISOString() }]);
    expect((await loadResultRows(project.session, runId))[0]?.disposition?.decision).toBe('false_positive');
    expect(await recordDisposition(project.session, runId, { ...issue, expectationId: 'E2' })).toContain('unclear');
    expect((await project.artifacts.loadClauses('M'))[1]?.status).toBe('unclear');
    expect((await Approvals.load(project.artifacts)).record('clause', 'M-AC-2')).toBeUndefined();
    expect(project.session.approvals.record('clause', 'M-AC-2')).toBeUndefined();
    await unlocked(project, runId);
  });

  it.each([
    { ...bug, caseId: 'M-TC-99' }, { ...bug, expectationId: 'E99' }, { ...bug, expectationId: 'E3' },
    { ...issue, clauseId: 'M-AC-99' }, { ...issue, clauseId: undefined },
  ])('拒绝任意ID、PASS预期或未覆盖条款 %j', async (input) => {
    const { project, runId } = await createFailedRun();
    await expect(recordDisposition(project.session, runId, input)).rejects.toThrow();
    expect(await dispositions(project, runId)).toBeUndefined();
    expect((await project.artifacts.loadClauses('M'))[1]?.status).toBe('active');
    await unlocked(project, runId);
  });

  it('拒绝过时或已删除条款，不改变当前条款和已有裁决', async () => {
    const { project, runId } = await createFailedRun();
    await recordDisposition(project.session, runId, bug);
    for (const clauses of [[clause(1), clause(2, { text: '新版条款' })], [clause(1)]]) {
      await project.artifacts.saveClauses('M', clauses);
      await expect(recordDisposition(project.session, runId, issue)).rejects.toThrow(/变化|不存在|过时/);
      expect(await project.artifacts.loadClauses('M')).toEqual(clauses);
      expect((await dispositions(project, runId))?.items[0]?.decision).toBe('confirmed_bug');
      await unlocked(project, runId);
    }
  });

  it('获取运行锁期间条款更新也拒绝，不用锁外旧条款覆盖新版', async () => {
    const { project, runId } = await createFailedRun();
    const publish = project.artifacts.publishExclusive.bind(project.artifacts);
    vi.spyOn(project.artifacts, 'publishExclusive').mockImplementation(async (rel, bytes) => {
      if (rel === `runs/${runId}/lock.json`) await project.artifacts.saveClauses('M', [clause(1), clause(2, { text: '锁获取期间新版' })]);
      return publish(rel, bytes);
    });
    await expect(recordDisposition(project.session, runId, issue)).rejects.toThrow('已变化');
    expect((await project.artifacts.loadClauses('M'))[1]).toMatchObject({ text: '锁获取期间新版', status: 'active' });
    expect(await dispositions(project, runId)).toBeUndefined();
    await unlocked(project, runId);
  });

  it('审核会话忙碌时不嵌套修改、不发布裁决并释放运行锁', async () => {
    const { project, runId } = await createFailedRun();
    await project.session.mutate(async () => {
      await expect(recordDisposition(project.session, runId, issue)).rejects.toThrow('忙碌');
      expect((await project.artifacts.loadClauses('M'))[1]?.status).toBe('active');
      expect(await dispositions(project, runId)).toBeUndefined();
      expect(await project.artifacts.readBytes(`runs/${runId}/lock.json`)).toBeUndefined();
    });
    await unlocked(project, runId);
  });

  it('运行锁内重读裁决，保留锁获取期间写入的其他预期裁决', async () => {
    const { project, runId } = await createFailedRun();
    const publish = project.artifacts.publishExclusive.bind(project.artifacts);
    vi.spyOn(project.artifacts, 'publishExclusive').mockImplementation(async (rel, bytes) => {
      if (rel === `runs/${runId}/lock.json`) await project.artifacts.writeJson(`runs/${runId}/dispositions.json`, {
        version: 1, runId, items: [{ ...bug, expectationId: 'E2', by: '另一个人', at: '2026-11-16T00:00:00.000Z' }],
      });
      return publish(rel, bytes);
    });
    await recordDisposition(project.session, runId, bug);
    expect((await dispositions(project, runId))?.items.map((d) => d.expectationId)).toEqual(['E2', 'E1']);
  });

  it('其他进程持锁时拒绝且不释放他人的锁', async () => {
    const { project, runId } = await createFailedRun();
    const run = await RunStore.load(project.artifacts, runId);
    await run.withLock(async () => {
      const before = await project.artifacts.readBytes(`runs/${runId}/lock.json`);
      await expect(recordDisposition(project.session, runId, bug)).rejects.toThrow('锁');
      expect(await project.artifacts.readBytes(`runs/${runId}/lock.json`)).toEqual(before);
      expect(await dispositions(project, runId)).toBeUndefined();
    });
    await unlocked(project, runId);
  });

  it.each(['条款', '确认', '裁决'])('%s写入失败明确报告实际部分状态且释放运行锁和会话', async (stage) => {
    const { project, runId } = await createFailedRun();
    const write = project.artifacts.writeBytes.bind(project.artifacts);
    const target = stage === '条款' ? 'requirements/M.yaml' : stage === '确认' ? 'approvals.json' : `runs/${runId}/dispositions.json`;
    vi.spyOn(project.artifacts, 'writeBytes').mockImplementation(async (rel, bytes) => {
      if (rel === target) throw new Error('注入写入故障');
      return write(rel, bytes);
    });
    const failure = await recordDisposition(project.session, runId, issue).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('磁盘裁决：未记录');
    expect((failure as Error).message).toContain(`条款 M-AC-2：${stage === '条款' ? 'active' : 'unclear'}`);
    expect((failure as Error).message).toContain(`条款确认：${stage === '裁决' ? '已撤销或无记录' : '仍有记录'}`);
    expect((failure as Error).message).toContain('运行锁：已释放');
    expect(await dispositions(project, runId)).toBeUndefined();
    expect((await project.artifacts.loadClauses('M'))[1]?.status).toBe(stage === '条款' ? 'active' : 'unclear');
    expect((await Approvals.load(project.artifacts)).record('clause', 'M-AC-2') !== undefined).toBe(stage !== '裁决');
    vi.restoreAllMocks();
    await unlocked(project, runId);
  });

  it('裁决已落盘但运行锁释放失败时报告真实完成状态，不伪称未记录', async () => {
    const { project, runId } = await createFailedRun();
    const remove = project.artifacts.remove.bind(project.artifacts);
    vi.spyOn(project.artifacts, 'remove').mockImplementation(async (rel) => {
      if (rel === `runs/${runId}/lock.json`) throw new Error('锁删除故障');
      return remove(rel);
    });
    await expect(recordDisposition(project.session, runId, bug)).rejects.toThrow(/磁盘裁决：确认是 bug.*锁删除故障/);
    expect((await dispositions(project, runId))?.items[0]?.decision).toBe('confirmed_bug');
    vi.restoreAllMocks();
    await project.artifacts.remove(`runs/${runId}/lock.json`);
    await unlocked(project, runId);
  });

  it('裁决文件归属错误时拒绝，不覆盖其他运行记录', async () => {
    const { project, runId } = await createFailedRun();
    await project.artifacts.writeJson(`runs/${runId}/dispositions.json`, { version: 1, runId: 'other', items: [] });
    await expect(recordDisposition(project.session, runId, bug)).rejects.toThrow('归属');
    expect((await dispositions(project, runId))?.runId).toBe('other');
    await unlocked(project, runId);
  });
});

describe('证据安全导出', () => {
  it.each([
    ['application/json; charset=utf-8', 'json'], ['application/har+json', 'json'],
    ['text/html', 'txt'], ['application/javascript', 'txt'], ['image/svg+xml', 'txt'],
    ['application/x-unknown', 'txt'], ['image/png', 'png'], ['image/jpeg', 'jpg'],
  ])('MIME %s 仅映射为安全扩展 %s', (mime, extension) => expect(extensionFor(mime)).toBe(extension));

  it('导出原字节到绝对 .open 路径，摘要不变，不信任调用方 MIME', async () => {
    const { project, runId } = await createFailedRun();
    const [row] = await loadResultRows(project.session, runId);
    const record = row!.evidence[0]!;
    const forged = { ...row!, evidence: [{ ...record, mime: 'image/png' }] };
    const file = await exportEvidence(project.session, runId, forged, record.id);
    expect(path.isAbsolute(file)).toBe(true);
    expect(file).toBe(project.artifacts.resolve(`.open/${record.id}.json`));
    const bytes = await readFile(file);
    expect(bytes).toEqual(await project.artifacts.readBytes(record.path));
    expect('sha256:' + createHash('sha256').update(bytes).digest('hex')).toBe(record.digest);
    await expect(exportEvidence(project.session, runId, row!, 'missing')).rejects.toThrow('证据不存在');
    await project.artifacts.writeBytes(record.path, Buffer.from('篡改'));
    await expect(exportEvidence(project.session, runId, row!, record.id)).rejects.toThrow('摘要');
  });

  it('真实提交点中的 HTML 和伪图片非截图证据均按文本导出', async () => {
    const { project, runId } = await createFailedRun();
    const [row] = await loadResultRows(project.session, runId);
    const record = row!.evidence[0]!;
    const indexRel = `runs/${runId}/cases/${row!.caseId}/attempts/${row!.attempt}/evidence/index.json`;
    const index = JSON.parse((await project.artifacts.readBytes(indexRel))!.toString()) as EvidenceRecord[];
    for (const mime of ['text/html', 'image/png']) {
      const changed = { ...record, mime, path: evidencePath(`runs/${runId}/cases/${row!.caseId}/attempts/${row!.attempt}`, record.id, mime) };
      await project.artifacts.writeBytes(changed.path, (await project.artifacts.readBytes(record.path))!);
      await project.artifacts.writeJson(indexRel, index.map((e) => e.id === record.id ? changed : e));
      const file = await exportEvidence(project.session, runId, { ...row!, evidence: [changed] }, record.id);
      expect(file.endsWith('.txt')).toBe(true);
    }
  });

  it('证据导出写入失败不返回成功路径', async () => {
    const { project, runId } = await createFailedRun();
    const [row] = await loadResultRows(project.session, runId);
    const write = project.artifacts.writeBytes.bind(project.artifacts);
    vi.spyOn(project.artifacts, 'writeBytes').mockImplementation(async (rel, bytes) => {
      if (rel.startsWith('.open/')) throw new Error('导出失败');
      return write(rel, bytes);
    });
    await expect(exportEvidence(project.session, runId, row!, row!.evidence[0]!.id)).rejects.toThrow('导出失败');
  });
});
