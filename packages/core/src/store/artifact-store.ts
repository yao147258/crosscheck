import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { z } from 'zod';
import { ModuleCasesSchema, ModuleClausesSchema, type Clause, type TestCase } from '../schema/artifacts';
import { ConfigSchema, type Config } from '../schema/config';

export class ArtifactError extends Error {
  override name = 'ArtifactError';
}

const MODULE_NAME = /^[A-Za-z0-9_-]+$/;
function assertModule(module: string): void {
  if (!MODULE_NAME.test(module)) throw new ArtifactError(`非法的模块名：${module}`);
}

/** 读写被测项目中的 .crosscheck 目录 */
export class ArtifactStore {
  readonly root: string;
  constructor(projectRoot: string) { this.root = path.resolve(projectRoot, '.crosscheck'); }

  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    const relative = path.relative(this.root, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ArtifactError(`路径超出 .crosscheck 目录：${rel}`);
    return abs;
  }

  /** 所有现存路径组件均拒绝链接；不保证抵御同机并发替换路径的攻击。 */
  private async checked(rel: string, createParents: boolean): Promise<string> {
    const abs = this.resolve(rel);
    const parent = path.dirname(this.root);
    const project = await realpath(parent);
    const components = [this.root, ...path.relative(this.root, abs).split(path.sep).filter(Boolean).map((_, i, all) => path.join(this.root, ...all.slice(0, i + 1)))];
    for (let i = 0; i < components.length; i++) {
      const current = components[i]!;
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new ArtifactError('工件路径不能包含符号链接或联接');
        const actual = await realpath(current);
        const base = i === 0 ? project : await realpath(this.root);
        const relative = path.relative(base, actual);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ArtifactError('工件路径超出物理边界');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (createParents && (i === 0 || i < components.length - 1)) {
          try { await mkdir(current); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
          const info = await lstat(current);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new ArtifactError('工件父目录不安全');
          const actual = await realpath(current);
          const base = i === 0 ? project : await realpath(this.root);
          const relative = path.relative(base, actual);
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ArtifactError('工件路径超出物理边界');
        } else break;
      }
    }
    return abs;
  }

  private error(action: string, err: unknown): ArtifactError {
    return err instanceof ArtifactError ? err : new ArtifactError(`工件${action}失败`, { cause: err });
  }

  async readBytes(rel: string): Promise<Buffer | undefined> {
    try { return await readFile(await this.checked(rel, false)); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw this.error('读取', err);
    }
  }
  async writeBytes(rel: string, bytes: Uint8Array): Promise<void> {
    let tmp: string | undefined;
    try {
      const abs = await this.checked(rel, true);
      tmp = `${abs}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, bytes, { flag: 'wx' });
      await this.renameRetrying(tmp, abs);
    } catch (err) { throw this.error('写入', err); }
    finally { if (tmp) await unlink(tmp).catch(() => {}); }
  }
  /** 排他创建用于运行锁；调用方负责锁内容和生命周期。 */
  async createExclusive(rel: string, bytes: Uint8Array): Promise<void> {
    try { await writeFile(await this.checked(rel, true), bytes, { flag: 'wx' }); }
    catch (err) { throw this.error('排他创建', err); }
  }
  /** 先完整关闭临时文件，再以硬链接原子发布，不覆盖既有目标。 */
  async publishExclusive(rel: string, bytes: Uint8Array): Promise<void> {
    let tmp: string | undefined;
    try {
      const abs = await this.checked(rel, true);
      tmp = `${abs}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, bytes, { flag: 'wx' });
      await link(tmp, abs);
    } catch (err) { throw this.error('排他发布', err); }
    finally { if (tmp) await unlink(tmp).catch(() => {}); }
  }
  async remove(rel: string): Promise<void> {
    try { await unlink(await this.checked(rel, false)); }
    catch (err) { throw this.error('删除', err); }
  }
  async list(rel: string): Promise<string[]> {
    try { return await readdir(await this.checked(rel, false)); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw this.error('列目录', err);
    }
  }
  private async renameRetrying(tmp: string, abs: string, attemptsLeft = 5): Promise<void> {
    try { await rename(tmp, abs); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attemptsLeft <= 0 || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
      await new Promise((r) => setTimeout(r, 5));
      await this.renameRetrying(tmp, abs, attemptsLeft - 1);
    }
  }
  private parse<T>(data: unknown, schema: z.ZodType<T>, rel = ''): T {
    const result = schema.safeParse(data);
    if (!result.success) throw new ArtifactError(`工件内容不合法：${rel}`, { cause: result.error });
    return result.data;
  }
  async readYaml<T>(rel: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const bytes = await this.readBytes(rel);
    if (bytes === undefined) return undefined;
    try { return this.parse(YAML.parse(bytes.toString('utf8')) ?? null, schema, rel); }
    catch (err) { throw this.error('解析', err); }
  }
  async writeYaml(rel: string, data: unknown): Promise<void> {
    try { await this.writeBytes(rel, Buffer.from(YAML.stringify(data, { lineWidth: 0 }))); }
    catch (err) { throw this.error('写入', err); }
  }
  async readJson<T>(rel: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const bytes = await this.readBytes(rel);
    if (bytes === undefined) return undefined;
    try { return this.parse(JSON.parse(bytes.toString('utf8')), schema, rel); }
    catch (err) { throw this.error('解析', err); }
  }
  async writeJson(rel: string, data: unknown): Promise<void> {
    try { await this.writeBytes(rel, Buffer.from(`${JSON.stringify(data, null, 2)}\n`)); }
    catch (err) { throw this.error('写入', err); }
  }
  async loadClauses(module: string): Promise<Clause[]> { assertModule(module); return (await this.readYaml(`requirements/${module}.yaml`, ModuleClausesSchema)) ?? []; }
  async saveClauses(module: string, clauses: Clause[]): Promise<void> { assertModule(module); await this.writeYaml(`requirements/${module}.yaml`, this.parse(clauses, ModuleClausesSchema)); }
  async loadCases(module: string): Promise<TestCase[]> { assertModule(module); return (await this.readYaml(`cases/${module}.yaml`, ModuleCasesSchema)) ?? []; }
  async saveCases(module: string, cases: TestCase[]): Promise<void> { assertModule(module); await this.writeYaml(`cases/${module}.yaml`, this.parse(cases, ModuleCasesSchema)); }
  async listModules(kind: 'requirements' | 'cases'): Promise<string[]> {
    return (await this.list(kind)).filter((n) => n.endsWith('.yaml')).map((n) => n.slice(0, -'.yaml'.length)).sort();
  }
  async loadConfig(): Promise<Config> {
    const cfg = await this.readYaml('config.yaml', ConfigSchema);
    if (!cfg) throw new ArtifactError('找不到 .crosscheck/config.yaml，请先运行 crosscheck init');
    return cfg;
  }
}
