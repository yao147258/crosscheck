import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore, ClauseSchema, TestCaseSchema, type Clause, type TestCase } from '@crosscheck/core';
import { ReviewSession } from '../src/index';

const roots: string[] = [];
export async function cleanupProjects(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export const PROFILE_FILES_CONTENT = {
  'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost:39999', healthcheck: 'http://localhost:39999/health', reset: null } } },
  'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' } } },
  'api-catalog.yaml': { version: 1, operations: {} },
  'pages.yaml': { version: 1, pages: {} },
  'data-model.yaml': { version: 1, queries: {} },
  'fixtures.yaml': { version: 1, fixtures: {} },
  'guardrails.yaml': { allowedHosts: ['localhost:39999'] },
};

export function clause(n: number, overrides: Partial<Clause> = {}): Clause {
  return ClauseSchema.parse({ id: `M-AC-${n}`, text: `条款 ${n}`, source: { file: '需求.md', line: n, excerpt: `原文 ${n}` }, ...overrides });
}

export function testCase(n: number, covers: string[], overrides: Partial<TestCase> = {}): TestCase {
  return TestCaseSchema.parse({ id: `M-TC-${n}`, covers, actor: 'guest', steps: ['检查接口'], expectations: [{ id: 'E1', text: '值为 ok', evidence: ['network'] }], ...overrides });
}

export async function createProject(options: { profile?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tui-'));
  roots.push(root);
  const artifacts = new ArtifactStore(root);
  const userHome = path.join(root, 'user'); await mkdir(path.join(userHome, '.crosscheck'), { recursive: true });
  await writeFile(path.join(userHome, '.crosscheck', 'config.yaml'), JSON.stringify({ models: { extractor: 'mock:x', planner: 'mock:p', executor: 'mock:e', reviewer: 'mock:r' }, providers: { mock: { type: 'ollama' } } }));
  await artifacts.writeYaml('config.yaml', { defaultEnvironment: 'local', budget: { perCase: { steps: 20, tokens: 100000, minutes: 1 } } });
  if (options.profile !== false) {
    for (const [name, value] of Object.entries(PROFILE_FILES_CONTENT)) await artifacts.writeYaml(`system/${name}`, value);
  }
  const session = await ReviewSession.open(artifacts, '测试人');
  return { root, userHome, artifacts, session };
}
