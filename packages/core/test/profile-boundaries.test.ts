import { describe, expect, it } from 'vitest';
import { ActorSchema, Approvals, caseApprovalPayload, ClauseSchema, CommandSchema, FixtureSchema, ProfileSchema, TestCaseSchema, TraceEventSchema } from '../src/index';

const source = { file: '操作.md', line: 1, excerpt: '知识来源' };
const profile = () => ({
  'environments.yaml': { version: 1, environments: { local: { baseURL: 'http://localhost', healthcheck: 'http://localhost/health', reset: 'seed', start: { program: 'node', argv: ['start.mjs'] } } } },
  'auth.yaml': { version: 1, actors: { guest: { kind: 'anonymous' }, member: { kind: 'token', env: 'TOKEN', inject: { kind: 'storage', storage: 'local', name: 'session' } } } },
  'api-catalog.yaml': { version: 1, operations: { seed: { environment: 'local', method: 'POST', path: '/seed', description: '准备数据', sources: [source], actor: 'member' } } },
  'pages.yaml': { version: 1, pages: { home: { environment: 'local', path: '/', description: '首页', sources: [source], actor: 'guest' } } },
  'data-model.yaml': { version: 1, connection: { kind: 'postgres', env: 'DATABASE_URL' }, queries: { seed: { sql: 'select $1', parameters: [{ name: 'count', type: 'number' }] } } },
  'fixtures.yaml': { version: 1, fixtures: { seed: { kind: 'sql', query: 'seed', params: [3], connection: { kind: 'postgres', env: 'FIXTURE_DATABASE_URL' } }, api: { kind: 'http', operation: 'seed', body: { count: 3 } }, command: { kind: 'command', command: { program: 'node', argv: ['seed.mjs'], env: { TOKEN: 'SEED_TOKEN' } } } } },
  'guardrails.yaml': { allowedHosts: ['localhost'] },
});
describe('画像契约边界', () => {
  it('完整具名 command/http/sql 结构可解析，固定参数类型与查询声明一致', () => {
    expect(ProfileSchema.safeParse(profile()).success).toBe(true);
    const bad = profile();
    bad['fixtures.yaml'].fixtures.seed.params = ['不是数字'] as unknown as number[];
    expect(ProfileSchema.safeParse(bad).success).toBe(false);
  });
  it('查询参数数量、缺连接、API/页面 actor/环境/fixture 操作引用不可悬空', () => {
    const wrongArity = profile();
    wrongArity['fixtures.yaml'].fixtures.seed.params = [];
    expect(ProfileSchema.safeParse(wrongArity).success).toBe(false);
    const noConnection: Record<string, unknown> = profile();
    noConnection['data-model.yaml'] = { version: 1, queries: profile()['data-model.yaml'].queries };
    expect(ProfileSchema.safeParse(noConnection).success).toBe(false);
    const badActor = profile();
    badActor['pages.yaml'].pages.home.actor = 'missing';
    expect(ProfileSchema.safeParse(badActor).success).toBe(false);
    const badEnv = profile();
    badEnv['api-catalog.yaml'].operations.seed.environment = 'missing';
    expect(ProfileSchema.safeParse(badEnv).success).toBe(false);
    const badOperation = profile();
    badOperation['fixtures.yaml'].fixtures.api.operation = 'missing';
    expect(ProfileSchema.safeParse(badOperation).success).toBe(false);
  });
  it('auth 仅允许受限动作，拒绝导航脚本、值字段和非法 env 变量', () => {
    expect(ActorSchema.safeParse({ kind: 'form', environment: 'local', actions: [{ kind: 'goto', url: '/login' }, { kind: 'fill', selector: '#name', env: 'USER_NAME' }, { kind: 'click', selector: '#submit' }, { kind: 'waitFor', selector: '#home' }] }).success).toBe(true);
    expect(ActorSchema.safeParse({ kind: 'replay', environment: 'local', actions: [{ kind: 'goto', url: 'javascript:alert(1)' }] }).success).toBe(false);
    expect(ActorSchema.safeParse({ kind: 'replay', environment: 'local', actions: [{ kind: 'fill', selector: '#x', value: 'password' }] }).success).toBe(false);
    expect(ActorSchema.safeParse({ kind: 'token', env: '真实密钥', inject: { kind: 'header', name: 'Authorization' } }).success).toBe(false);
    expect(ActorSchema.safeParse({ kind: 'command', command: { program: 'node', argv: ['login.mjs'], env: { TOKEN: 'LOGIN_TOKEN' } } }).success).toBe(true);
    expect(CommandSchema.safeParse({ program: 'node', argv: [], shell: true }).success).toBe(false);
    expect(FixtureSchema.safeParse({ kind: 'script', script: '代码' }).success).toBe(false);
  });
  it('未知版本、直接凭证、判定标准字段与重复参数均拒绝', () => {
    const badVersion = profile();
    badVersion['auth.yaml'].version = 2;
    expect(ProfileSchema.safeParse(badVersion).success).toBe(false);
    const badQuery = profile();
    badQuery['data-model.yaml'].queries.seed.parameters.push({ name: 'count', type: 'number' });
    expect(ProfileSchema.safeParse(badQuery).success).toBe(false);
    expect(ActorSchema.safeParse({ kind: 'anonymous', password: '密钥' }).success).toBe(false);
    const badPage = profile();
    Object.assign(badPage['pages.yaml'].pages.home, { expectations: ['应当通过'] });
    expect(ProfileSchema.safeParse(badPage).success).toBe(false);
  });
});
describe('确认与 trace 边界', () => {
  const clause = (id: string) => ClauseSchema.parse({ id, text: id, source });
  const c1 = clause('M-AC-1');
  const c2 = clause('M-AC-2');
  const tc = TestCaseSchema.parse({ id: 'M-TC-1', covers: [c2.id, c1.id], actor: 'guest', steps: ['打开'], expectations: [{ id: 'E1', text: '显示', evidence: ['dom'] }] });
  it('covers 和条款顺序不影响确认，无关条款不参与哈希', () => {
    const approvals = Approvals.empty();
    approvals.approveCase(tc, [c1, c2], '人工');
    expect(approvals.stateCase({ ...tc, covers: [c1.id, c2.id] }, [c2, c1, clause('M-AC-3')])).toBe('approved');
    expect(() => caseApprovalPayload(tc, [c1])).toThrow('缺失');
    expect(() => approvals.approveCase(tc, [c1, c2, c2], '人工')).toThrow('重复');
  });
  it('trace 要求运行归属、阶段、动作、序号与安全标识', () => {
    const trace = { runId: 'run-1', caseId: tc.id, actionId: 'a-1', attempt: 1, phase: 'preparation', time: '2026-11-13T00:00:00Z', event: 'blocked', message: '等待确认', action: { type: 'prepare', locator: null, input: null }, beforeEvidenceIds: [], afterEvidenceIds: [], result: { status: 'blocked', output: null, error: '等待确认' }, durationMs: 0 };
    expect(TraceEventSchema.safeParse(trace).success).toBe(true);
    expect(TraceEventSchema.safeParse({ ...trace, attempt: 0 }).success).toBe(false);
    expect(TraceEventSchema.safeParse({ ...trace, actionId: '../x' }).success).toBe(false);
  });
});
