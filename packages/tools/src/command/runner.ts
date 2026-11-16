import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CommandSchema, RuntimeIdSchema, type Command, type ArtifactStore } from '@crosscheck/core';
import type { EvidenceRedactor } from '../evidence/redactor';

export type CommandErrorKind = 'blocked' | 'cancelled' | 'limit' | 'timeout';
export class CommandOperationError extends Error {
  constructor(readonly kind: CommandErrorKind) { super({blocked:'批准命令失败或未返回有效 JSON',cancelled:'批准命令已取消',limit:'批准命令输出超过上限',timeout:'批准命令超时'}[kind]); }
}
export interface CommandRunnerOptions { env?:Record<string,string|undefined>; maxBytes?:number; timeoutMs?:number }
/** 人工信任的适配器，不是 OS 沙箱；原始输出只存在本次宿主调用内存中。 */
export class ApprovedCommandRunner {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  constructor(private readonly artifacts: ArtifactStore, private readonly runId: string, private readonly redactor: EvidenceRedactor, private readonly options: CommandRunnerOptions = {}) {
    RuntimeIdSchema.parse(runId);
    this.maxBytes = options.maxBytes ?? 256 * 1024;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 256 * 1024 || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new Error('命令资源上限不合法');
  }
  /** 只允许宿主传入已批准的 Command；不得将本方法作为模型工具直接暴露。 */
  async run(command: Command, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new CommandOperationError('cancelled');
    const checked = CommandSchema.safeParse(command);
    if (!checked.success) throw new CommandOperationError('blocked');
    command = checked.data;
    const env: Record<string,string> = Object.create(null);
    const source = this.options.env ?? process.env;
    for (const [name, ref] of Object.entries(command.env)) {
      if (!Object.hasOwn(source, ref) || source[ref] === undefined) throw new CommandOperationError('blocked');
      env[name] = source[ref]!;
    }
    this.redactor.addSecrets(Object.values(env));
    const marker = `runs/${this.runId}/commands/${randomUUID()}/.cwd`;
    await this.artifacts.createExclusive(marker, Buffer.alloc(0));
    if (signal.aborted) throw new CommandOperationError('cancelled');
    const cwd = path.dirname(this.artifacts.resolve(marker));
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try { child = spawn(command.program, command.argv, {shell:false,env,cwd,detached:process.platform !== 'win32',windowsHide:true,stdio:['ignore','pipe','pipe']}); }
      catch { reject(new CommandOperationError('blocked')); return; }
      let kind: CommandErrorKind | undefined;
      let bytes = 0;
      const chunks: Buffer[] = [];
      let killing: Promise<void> | undefined;
      let killError: Error | undefined;
      const killTree = async () => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
          await new Promise<void>((done, fail) => {
            const killer = spawn(executable, ['/PID',String(child.pid),'/T','/F'], {shell:false,windowsHide:true,stdio:'ignore'});
            const deadline = setTimeout(() => { killer.kill(); fail(new Error('命令进程树清理超时')); }, 5000);
            killer.once('error', () => { clearTimeout(deadline); fail(new Error('命令进程树清理失败')); });
            killer.once('close', code => { clearTimeout(deadline); if (code === 0) done(); else { try { process.kill(child.pid!,0); fail(new Error('命令进程树清理失败')); } catch { done(); } } });
          });
        } else {
          try { process.kill(-child.pid,'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('命令进程树清理失败'); }
        }
      };
      const stop = (reason: CommandErrorKind) => {
        kind ??= reason;
        killing ??= killTree().catch(error => { killError = error; child.kill('SIGKILL'); });
      };
      const abort = () => stop('cancelled');
      signal.addEventListener('abort',abort,{once:true});
      const timer = setTimeout(() => stop('timeout'),this.timeoutMs);
      if (signal.aborted) stop('cancelled');
      const capture = (part: Buffer, stdout: boolean) => {
        if (kind) return;
        bytes += part.length;
        if (bytes > this.maxBytes) { chunks.length = 0; stop('limit'); return; }
        if (stdout) chunks.push(part);
      };
      child.stdout!.on('data', part => capture(part,true));
      child.stderr!.on('data', part => capture(part,false));
      child.once('error', () => { kind ??= 'blocked'; });
      child.once('close', async code => {
        clearTimeout(timer); signal.removeEventListener('abort',abort);
        await killing;
        if (killError) { reject(killError); return; }
        if (kind || code !== 0) { reject(new CommandOperationError(kind ?? 'blocked')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new CommandOperationError('blocked')); }
      });
    });
  }
}
