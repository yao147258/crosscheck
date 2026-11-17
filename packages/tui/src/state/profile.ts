import { PROFILE_SCHEMAS, loadProfile, readProfileFile, readProfileFiles, type ApprovalState, type ProfileFile } from '@crosscheck/core';
import YAML from 'yaml';
import type { z } from 'zod';
import { editValidated, parseYamlWith } from '../io/edit-loop';
import type { EditorHost } from '../io/editor';
import type { ReadonlyReviewContext, ReviewSession } from '../io/session';

export type ProfileRowStatus = ApprovalState | 'missing' | 'invalid';
export interface ProfileRow { name: ProfileFile; status: ProfileRowStatus; error?: string; details: string[] }
export interface ProfileOverview { rows: ProfileRow[]; crossCheck?: string }

export async function loadProfileOverview(session: ReadonlyReviewContext): Promise<ProfileOverview> {
  // 详情随已有受跟踪加载一起完成，Enter 不再发起后台读盘。
  const rows: ProfileRow[] = [];
  for (const file of await readProfileFiles(session.artifacts)) {
    if (!file.present) { rows.push({ name: file.name, status: 'missing', details: ['文件不存在，请先编辑或运行 crosscheck init'] }); continue; }
    if (!file.ok) {
      const raw = (await session.artifacts.readBytes(`system/${file.name}`))?.toString('utf8') ?? '';
      // 控制字符以可见转义呈现，避免非法原文被终端当成指令。
      const safe = raw.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
      rows.push({ name: file.name, status: 'invalid', error: file.error, details: ['不合法，不能确认；以下为原文', file.error, ...safe.split(/\r?\n/)] });
      continue;
    }
    rows.push({ name: file.name, status: session.approvals.state('profile', file.name, file.value), details: ['审批载荷（含 schema 默认值）', ...YAML.stringify(file.value, { lineWidth: 0 }).split('\n')] });
  }
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
