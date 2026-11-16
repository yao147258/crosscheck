import { createContext, useContext } from 'react';
import type { EditorHost } from './io/editor';
import type { ReviewSession } from './io/session';

export interface ReviewEnv { session: ReviewSession; editor: EditorHost; open: (file: string) => Promise<void>; signal?: AbortSignal }
export const ReviewContext = createContext<ReviewEnv | null>(null);

export const ActionContext = createContext<{
  busy: { current: boolean };
  changed(): void;
} | null>(null);

export function useReview(): ReviewEnv {
  const env = useContext(ReviewContext);
  if (!env) throw new Error('缺少 ReviewContext');
  return env;
}
