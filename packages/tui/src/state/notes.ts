import { decodeNotesUtf8, NotesTextSchema, type ApprovalState } from '@crosscheck/core';
import { z } from 'zod';
import { editValidated } from '../io/edit-loop';
import type { EditorHost } from '../io/editor';
import type { ReadonlyReviewContext, ReviewSession } from '../io/session';

export const NOTES_FILE = 'notes.md';
export const NOTES_ID = 'project';
export interface NotesOverview { text: string; status: ApprovalState }

async function readNotes(session: ReadonlyReviewContext): Promise<string> {
  const raw = await session.artifacts.readBytes(NOTES_FILE);
  if (raw === undefined) throw new Error('notes.md 不存在，请先运行 crosscheck init');
  return decodeNotesUtf8(raw);
}

export function validateNotesText(text: string): string {
  return NotesTextSchema.parse(text);
}

export async function loadNotesOverview(session: ReadonlyReviewContext): Promise<NotesOverview> {
  const text = await readNotes(session);
  return { text, status: session.approvals.state('notes', NOTES_ID, text) };
}

export async function approveNotes(session: ReviewSession, expectedText: string): Promise<string> {
  if (typeof expectedText !== 'string') throw new Error('请先查看笔记后确认');
  await session.mutate(async (approvals) => {
    const text = await readNotes(session);
    if (text !== expectedText) throw new Error('notes.md 已变化，请重新查看后确认');
    validateNotesText(text);
    approvals.approve('notes', NOTES_ID, text, session.reviewer);
  });
  return '已确认项目笔记';
}

export async function revokeNotes(session: ReviewSession): Promise<string> {
  await session.mutate((approvals) => approvals.revoke('notes', NOTES_ID));
  return '已撤销项目笔记的确认';
}

export async function editNotes(session: ReviewSession, editor: EditorHost): Promise<string> {
  const initial = await session.artifacts.readBytes(NOTES_FILE);
  const outcome = await editValidated(editor, initial === undefined ? '' : decodeNotesUtf8(initial), (text) => {
    const result = NotesTextSchema.safeParse(text);
    return result.success ? { ok: true, value: result.data } : { ok: false, error: z.prettifyError(result.error) };
  });
  if (outcome.status === 'cancelled') return '未修改';
  await session.mutate(async () => {
    const current = await session.artifacts.readBytes(NOTES_FILE);
    if (initial === undefined ? current !== undefined : current === undefined || !current.equals(initial)) {
      throw new Error('notes.md 在编辑期间已变化，请重新编辑');
    }
    await session.artifacts.writeBytes(NOTES_FILE, Buffer.from(outcome.text));
  });
  return '已保存 notes.md';
}
