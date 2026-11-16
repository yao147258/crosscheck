import { z } from 'zod';
import { ArtifactError, contentHash, DigestSchema, type ArtifactStore, type VerifiedRunInputs } from '@crosscheck/core';
import { RunStore } from './store/run-store';

export const EXECUTION_POLICY = 'plan2-task9-http-db-v1';
const SnapshotSchema = z.strictObject({ version: z.literal(1), policy: z.literal(EXECUTION_POLICY), sourceFingerprint: DigestSchema, fingerprint: DigestSchema, display: z.unknown(), displayDigest: DigestSchema });
export function executionFingerprint(input: VerifiedRunInputs, resilience: { retries?: number; baseDelayMs?: number } = {}): string {
  return contentHash({ sourceFingerprint: input.fingerprint, policy: EXECUTION_POLICY, retries: resilience.retries ?? 3, baseDelayMs: resilience.baseDelayMs ?? 500 });
}
export function snapshot(input: VerifiedRunInputs, fingerprint: string, display: unknown) {
  return { version: 1, policy: EXECUTION_POLICY, sourceFingerprint: input.fingerprint, fingerprint, display, displayDigest: contentHash(display) };
}
export async function verifySnapshot(artifacts: ArtifactStore, run: RunStore, input: VerifiedRunInputs, fingerprint: string): Promise<void> {
  const saved = await artifacts.readJson(`runs/${run.manifest.runId}/input.json`, SnapshotSchema);
  if (!saved || saved.sourceFingerprint !== input.fingerprint || saved.fingerprint !== fingerprint || run.manifest.fingerprint !== fingerprint || contentHash(saved.display) !== saved.displayDigest) throw new ArtifactError('恢复输入或执行策略指纹不一致，拒绝 resume');
}
export async function findResume(artifacts: ArtifactStore, resume: string | true, fingerprint: string): Promise<RunStore> {
  if (typeof resume === 'string') return RunStore.load(artifacts, resume);
  for (const id of (await artifacts.list('runs')).sort().reverse()) {
    const run = await RunStore.load(artifacts, id);
    if (run.manifest.fingerprint === fingerprint && run.manifest.status !== 'completed') return run;
  }
  throw new ArtifactError('没有兼容的未完成运行指纹');
}
