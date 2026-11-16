import type { ArtifactStore } from '@crosscheck/core';
import { render } from 'ink';
import { createElement } from 'react';
import { App } from './app';
import type { EditorHost } from './io/editor';
import { ReviewSession } from './io/session';
import { initialRoute, type ReviewView } from './routes';

export { App } from './app';
export * from './routes';
export type { ReviewEnv } from './context';
export * from './io/session';
export * from './io/editor';
export * from './io/edit-loop';
export * from './io/opener';
export * from './state/profile';
export * from './state/clauses';
export * from './state/cases';
export * from './state/results';
export * from './state/home';

export interface RunReviewOptions {
  artifacts: ArtifactStore;
  reviewer: string;
  editor: EditorHost;
  open: (file: string) => Promise<void>;
  view?: ReviewView;
  module?: string;
  runId?: string;
}

export async function runReview(options: RunReviewOptions): Promise<number> {
  const session = await ReviewSession.open(options.artifacts, options.reviewer);
  const instance = render(createElement(App, {
    env: { session, editor: options.editor, open: options.open },
    initial: initialRoute(options.view, options.module, options.runId),
  }), { exitOnCtrlC: false });
  try {
    const result = await instance.waitUntilExit();
    return result === 2 ? 2 : 0;
  } finally {
    instance.cleanup();
  }
}
