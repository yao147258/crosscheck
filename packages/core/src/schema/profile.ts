import { z } from 'zod';
import { SourceRefSchema } from './artifacts';
import { GuardrailsSchema } from './guardrails';

export const ProfileNameSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, '名称只能包含字母、数字、下划线、点和短横线').refine((s) => s !== '..', '名称不能路径逃逸');
export const EnvRefSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, '这里只写环境变量名，不能写密钥值');
export const HttpUrlSchema = z.string().url().refine((s) => ['http:', 'https:'].includes(new URL(s).protocol), 'URL 必须使用 http/https');
export const JsonValueSchema = z.json();
export const CommandSchema = z.strictObject({ program: z.string().min(1), argv: z.array(z.string()), env: z.record(EnvRefSchema, EnvRefSchema).default({}) });
export type Command = z.infer<typeof CommandSchema>;

export const EnvironmentSchema = z.strictObject({
  baseURL: HttpUrlSchema,
  healthcheck: HttpUrlSchema,
  reset: ProfileNameSchema.nullable(),
  start: CommandSchema.optional(),
  stop: CommandSchema.optional(),
});
export const EnvironmentsSchema = z.discriminatedUnion('version', [z.strictObject({ version: z.literal(1), environments: z.record(ProfileNameSchema, EnvironmentSchema) })]);

/** 只允许固定导航、点击、环境变量填入和等待；没有脚本执行或模板解释器。 */
export const AuthActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('goto'), url: z.string().min(1).refine((url) => (url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) || HttpUrlSchema.safeParse(url).success, '导航地址必须是 http/https URL 或站内绝对路径') }),
  z.strictObject({ kind: z.literal('click'), selector: z.string().min(1) }),
  z.strictObject({ kind: z.literal('fill'), selector: z.string().min(1), env: EnvRefSchema }),
  z.strictObject({ kind: z.literal('waitFor'), selector: z.string().min(1) }),
]);
export const TokenInjectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('header'), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal('cookie'), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal('storage'), storage: z.enum(['local', 'session']), name: z.string().min(1) }),
]);
export const ActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('anonymous') }),
  z.strictObject({ kind: z.literal('form'), environment: ProfileNameSchema, actions: z.array(AuthActionSchema).min(1) }),
  z.strictObject({ kind: z.literal('token'), env: EnvRefSchema, inject: TokenInjectionSchema }),
  z.strictObject({ kind: z.literal('replay'), environment: ProfileNameSchema, actions: z.array(AuthActionSchema).min(1) }),
  z.strictObject({ kind: z.literal('command'), command: CommandSchema }),
]);
export const AuthSchema = z.discriminatedUnion('version', [z.strictObject({ version: z.literal(1), actors: z.record(ProfileNameSchema, ActorSchema) })]);
export type Actor = z.infer<typeof ActorSchema>;

export const ApiOperationSchema = z.strictObject({
  environment: ProfileNameSchema,
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
  path: z.string().min(1),
  description: z.string().min(1),
  knowledge: z.array(z.string()).default([]),
  sources: z.array(SourceRefSchema).min(1),
  actor: ProfileNameSchema.optional(),
});
export const ApiCatalogSchema = z.discriminatedUnion('version', [z.strictObject({ version: z.literal(1), operations: z.record(ProfileNameSchema, ApiOperationSchema) })]);
export const PageSchema = z.strictObject({ environment: ProfileNameSchema, path: z.string().min(1), description: z.string().min(1), knowledge: z.array(z.string()).default([]), sources: z.array(SourceRefSchema).min(1), actor: ProfileNameSchema.optional() });
export const PagesSchema = z.discriminatedUnion('version', [z.strictObject({ version: z.literal(1), pages: z.record(ProfileNameSchema, PageSchema) })]);

export const QueryParameterSchema = z.strictObject({ name: ProfileNameSchema, type: z.enum(['string', 'number', 'boolean', 'json']), nullable: z.boolean().default(false) });
export const NamedQuerySchema = z.strictObject({ sql: z.string().min(1), parameters: z.array(QueryParameterSchema) }).superRefine((query, ctx) => {
  if (new Set(query.parameters.map((p) => p.name)).size !== query.parameters.length) ctx.addIssue({ code: 'custom', message: '查询参数名重复' });
});
export const PostgresConnectionSchema = z.strictObject({ kind: z.literal('postgres'), env: EnvRefSchema });
export const DataModelSchema = z.discriminatedUnion('version', [z.strictObject({
  version: z.literal(1),
  connection: PostgresConnectionSchema.optional(),
  queries: z.record(ProfileNameSchema, NamedQuerySchema),
})]);
export const FixtureSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command'), command: CommandSchema }),
  z.strictObject({ kind: z.literal('http'), operation: ProfileNameSchema, body: JsonValueSchema.optional() }),
  z.strictObject({ kind: z.literal('sql'), query: ProfileNameSchema, params: z.array(JsonValueSchema), connection: PostgresConnectionSchema }),
]);
export type Fixture = z.infer<typeof FixtureSchema>;
export const FixturesSchema = z.discriminatedUnion('version', [z.strictObject({ version: z.literal(1), fixtures: z.record(ProfileNameSchema, FixtureSchema) })]);

/** 宿主枚举必需文件；不使用调用方提供的清单推断完整性。 */
export const PROFILE_FILES = ['environments.yaml', 'auth.yaml', 'api-catalog.yaml', 'pages.yaml', 'data-model.yaml', 'fixtures.yaml', 'guardrails.yaml'] as const;
export type ProfileFile = (typeof PROFILE_FILES)[number];
export const PROFILE_SCHEMAS = {
  'environments.yaml': EnvironmentsSchema,
  'auth.yaml': AuthSchema,
  'api-catalog.yaml': ApiCatalogSchema,
  'pages.yaml': PagesSchema,
  'data-model.yaml': DataModelSchema,
  'fixtures.yaml': FixturesSchema,
  'guardrails.yaml': GuardrailsSchema,
} as const;
export const ProfileSchema = z.strictObject(PROFILE_SCHEMAS).superRefine((profile, ctx) => {
  const envs = profile['environments.yaml'].environments;
  const actors = profile['auth.yaml'].actors;
  const operations = profile['api-catalog.yaml'].operations;
  const db = profile['data-model.yaml'];
  const fixtures = profile['fixtures.yaml'].fixtures;
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  for (const [name, env] of Object.entries(envs)) if (env.reset !== null && !Object.hasOwn(fixtures, env.reset)) issue(`环境 ${name} 的 reset fixture 不存在：${env.reset}`);
  for (const [name, actor] of Object.entries(actors)) if ('environment' in actor && !Object.hasOwn(envs, actor.environment)) issue(`角色 ${name} 的环境不存在：${actor.environment}`);
  for (const [name, item] of [...Object.entries(operations), ...Object.entries(profile['pages.yaml'].pages)]) {
    if (!Object.hasOwn(envs, item.environment)) issue(`操作或页面 ${name} 的环境不存在：${item.environment}`);
    if (item.actor && !Object.hasOwn(actors, item.actor)) issue(`操作或页面 ${name} 的 actor 不存在：${item.actor}`);
  }
  if (Object.keys(db.queries).length > 0 && !db.connection) issue('具名查询必须声明数据库连接环境变量');
  for (const [name, fixture] of Object.entries(fixtures)) {
    if (fixture.kind === 'http' && !Object.hasOwn(operations, fixture.operation)) issue(`fixture ${name} 的 API 操作不存在：${fixture.operation}`);
    if (fixture.kind === 'sql') {
      if (fixture.connection.env === db.connection?.env) issue(`SQL fixture ${name} 的准备连接不能复用只读查询连接环境变量：${fixture.connection.env}`);
      const query = Object.hasOwn(db.queries, fixture.query) ? db.queries[fixture.query] : undefined;
      if (!query) issue(`fixture ${name} 的查询不存在：${fixture.query}`);
      else {
        if (query.parameters.length !== fixture.params.length) issue(`fixture ${name} 的查询参数数量不匹配`);
        query.parameters.forEach((parameter, index) => {
          const value = fixture.params[index];
          if (value === undefined) return;
          if (value === null ? !parameter.nullable : parameter.type !== 'json' && typeof value !== parameter.type) issue(`fixture ${name} 的查询参数类型不匹配：${parameter.name}`);
        });
      }
    }
  }
});
export type Profile = z.infer<typeof ProfileSchema>;
