import { PROFILE_SCHEMAS, loadProfile, readProfileFile, readProfileFiles, type ApprovalState, type ProfileFile } from '@crosscheck/core';
import type { z } from 'zod';
import { editValidated, parseYamlWith } from '../io/edit-loop';
import type { EditorHost } from '../io/editor';
import type { ReviewSession } from '../io/session';

export type ProfileRowStatus = ApprovalState | 'missing' | 'invalid';
export interface ProfileRow { name: ProfileFile; status: ProfileRowStatus; error?: string }
export interface ProfileOverview { rows: ProfileRow[]; crossCheck?: string }

export async function loadProfileOverview(session: ReviewSession): Promise<ProfileOverview> {
  const rows = (await readProfileFiles(session.artifacts)).map((file): ProfileRow => {
    if (!file.present) return { name: file.name, status: 'missing' };
    if (!file.ok) return { name: file.name, status: 'invalid', error: file.error };
    return { name: file.name, status: session.approvals.state('profile', file.name, file.value) };
  });
  let crossCheck: string | undefined;
  if (rows.every((row) => row.status === 'approved')) {
    try { await loadProfile(session.artifacts); }
    catch (error) { crossCheck = error instanceof Error ? error.message : String(error); }
  }
  return { rows, crossCheck };
}

export async function approveProfileFile(session: ReviewSession, name: ProfileFile): Promise<string> {
  await session.mutate(async (approvals) => {
    const file = await readProfileFile(session.artifacts, name);
    if (!file.present) throw new Error(`${name} 不存在，请先编辑或运行 crosscheck init`);
    if (!file.ok) throw new Error(`${name} 不合法，不能确认：${file.error}`);
    approvals.approve('profile', name, file.value, session.reviewer);
  });
  return `已确认 ${name}`;
}

export async function revokeProfileFile(session: ReviewSession, name: ProfileFile): Promise<string> {
  await session.mutate((approvals) => approvals.revoke('profile', name));
  return `已撤销 ${name} 的确认`;
}

export async function editProfileFile(session: ReviewSession, editor: EditorHost, name: ProfileFile): Promise<string> {
  const rel = `system/${name}`;
  const initial = await session.artifacts.readBytes(rel);
  const outcome = await editValidated(editor, initial?.toString('utf8') ?? '', (text) => parseYamlWith(text, PROFILE_SCHEMAS[name] as z.ZodType));
  if (outcome.status === 'cancelled') return '未修改';
  await session.mutate(async () => {
    const current = await session.artifacts.readBytes(rel);
    if (current?.toString('utf8') !== initial?.toString('utf8')) throw new Error(`${name} 在编辑期间已变化，请重新编辑`);
    await session.artifacts.writeBytes(rel, Buffer.from(outcome.text));
  });
  return `已保存 ${name}`;
}
