import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
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

/** 读写被测项目中的 .crosscheck/ 目录；所有写入都被限制在该目录内 */
export class ArtifactStore {
  readonly root: string;

  constructor(projectRoot: string) {
    this.root = path.resolve(projectRoot, '.crosscheck');
  }

  /** 解析相对路径，结果必须位于 .crosscheck/ 内 */
  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    const relative = path.relative(this.root, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ArtifactError(`路径超出 .crosscheck 目录：${rel}`);
    }
    return abs;
  }

  private async readText(rel: string): Promise<string | undefined> {
    try {
      return await readFile(this.resolve(rel), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /** 先写临时文件再改名，避免中断时留下半个文件 */
  private async writeText(rel: string, text: string): Promise<void> {
    const abs = this.resolve(rel);
    await mkdir(path.dirname(abs), { recursive: true });
    // 临时文件名包含随机 UUID：同进程并发写同一路径时 pid 相同会冲突，UUID 保证互不相同
    const tmp = `${abs}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await this.renameRetrying(tmp, abs);
  }

  /**
   * 并发往同一目标路径改名时，Windows 上偶发 EPERM/EBUSY（目标文件被另一次改名短暂占用），
   * 属于瞬时竞争，短暂重试即可
   */
  private async renameRetrying(tmp: string, abs: string, attemptsLeft = 5): Promise<void> {
    try {
      await rename(tmp, abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attemptsLeft <= 0 || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
      await new Promise((r) => setTimeout(r, 5));
      await this.renameRetrying(tmp, abs, attemptsLeft - 1);
    }
  }

  private parse<T>(rel: string, data: unknown, schema: z.ZodType<T>): T {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ArtifactError(`${path.join('.crosscheck', rel)} 内容不合法：${result.error.message}`);
    }
    return result.data;
  }

  async readYaml<T>(rel: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const text = await this.readText(rel);
    if (text === undefined) return undefined;
    return this.parse(rel, YAML.parse(text) ?? null, schema);
  }

  async writeYaml(rel: string, data: unknown): Promise<void> {
    await this.writeText(rel, YAML.stringify(data, { lineWidth: 0 }));
  }

  async readJson<T>(rel: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const text = await this.readText(rel);
    if (text === undefined) return undefined;
    return this.parse(rel, JSON.parse(text), schema);
  }

  async writeJson(rel: string, data: unknown): Promise<void> {
    await this.writeText(rel, `${JSON.stringify(data, null, 2)}\n`);
  }

  async loadClauses(module: string): Promise<Clause[]> {
    assertModule(module);
    return (await this.readYaml(`requirements/${module}.yaml`, ModuleClausesSchema)) ?? [];
  }

  async saveClauses(module: string, clauses: Clause[]): Promise<void> {
    assertModule(module);
    await this.writeYaml(`requirements/${module}.yaml`, ModuleClausesSchema.parse(clauses));
  }

  async loadCases(module: string): Promise<TestCase[]> {
    assertModule(module);
    return (await this.readYaml(`cases/${module}.yaml`, ModuleCasesSchema)) ?? [];
  }

  async saveCases(module: string, cases: TestCase[]): Promise<void> {
    assertModule(module);
    await this.writeYaml(`cases/${module}.yaml`, ModuleCasesSchema.parse(cases));
  }

  async listModules(kind: 'requirements' | 'cases'): Promise<string[]> {
    try {
      const names = await readdir(this.resolve(kind));
      return names
        .filter((n) => n.endsWith('.yaml'))
        .map((n) => n.slice(0, -'.yaml'.length))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async loadConfig(): Promise<Config> {
    const cfg = await this.readYaml('config.yaml', ConfigSchema);
    if (!cfg) throw new ArtifactError('找不到 .crosscheck/config.yaml，请先运行 crosscheck init');
    return cfg;
  }
}
