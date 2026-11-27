import type { ArtifactStore, ProfileFile } from '@crosscheck/core';
import { render } from 'ink';
import { createElement } from 'react';
import { App } from './app';
import type { EditorHost } from './io/editor';
import { ReviewSession } from './io/session';
import { initialRoute, type ReviewView } from './routes';

export { App } from './app';
export * from './session';
export * from './routes';
export type { ReviewEnv } from './context';
export * from './io/session';
export * from './io/editor';
export * from './io/edit-loop';
export * from './io/opener';
export { escapeTerminalLine } from './io/terminal';
export * from './state/profile';
export * from './state/notes';
export * from './state/clauses';
export * from './state/cases';
export * from './state/results';
export * from './state/home';
export * from './state/status';

export interface RunReviewOptions {
  artifacts: ArtifactStore;
  reviewer: string;
  editor: EditorHost;
  open: (file: string) => Promise<void>;
  view?: ReviewView;
  module?: string;
  runId?: string;
  only?: ProfileFile[];
  signal?: AbortSignal;
}

export async function runReview(options: RunReviewOptions): Promise<number> {
  if (options.signal?.aborted) return 2;
  const session = await ReviewSession.open(options.artifacts, options.reviewer);
  if (options.signal?.aborted) return 2;
  const instance = render(createElement(App, {
    env: { session, editor: options.editor, open: options.open, signal: options.signal },
    initial: initialRoute(options.view, options.module, options.runId, options.only),
  }), { exitOnCtrlC: false });
  try {
    const result = await instance.waitUntilExit();
    return result === 2 ? 2 : 0;
  } finally {
    instance.cleanup();
  }
}
