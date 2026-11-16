import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../../core/src/index';
import { createEvidenceRedactor } from '../src/evidence/redactor';
import { EvidenceStore } from '../src/evidence/store';
import { ApprovedCommandRunner } from '../src/command/runner';

const roots: string[] = [];
const signal = () => new AbortController().signal;
const meta = { actionId: 'a-7', phase: 'preparation' as const };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'task7-')); roots.push(root);
  const artifacts = new ArtifactStore(root), redactor = createEvidenceRedactor();
  const store = new EvidenceStore(artifacts, {runId:'run-7',caseId:'M-TC-1',attempt:1}, redactor);
  return { root, artifacts, redactor, store };
}
it('动态秘密立即影响已创建仓库、文本和编码变体', async () => {
  const {store, redactor} = await setup();
  redactor.addSecrets(['dynamic/a b']);
  const record = await store.saveText('console', 'dynamic/a b dynamic%2fa+b', meta);
  expect((await store.verify(record)).toString()).toBe('[REDACTED] [REDACTED]');
});
it('宿主仅从真实登记且验摘要的完整 JSON HTTP 响应读变量', async () => {
  const {store, artifacts} = await setup();
  const record = await store.saveHar({log:{entries:[{response:{status:201,content:{mimeType:'application/json',text:'{"id":7,"password":"unknown"}'}}}]}}, meta);
  expect(await store.readHttpResponse(record.id)).toEqual({status:201,body:{id:7,password:'[REDACTED]'}});
  await expect(store.readHttpResponse('../any')).rejects.toThrow();
  await artifacts.writeBytes(record.path, Buffer.from('{}'));
  await expect(store.readHttpResponse(record.id)).rejects.toThrow();
});
it.each([{truncated:true,text:'{}'}, {text:'not json'}, {mimeType:'text/plain',text:'{}'}])('省略、截断或非 JSON 响应不能作为夹具完成变量 %j', async content => {
  const {store} = await setup();
  const record = await store.saveHar({log:{entries:[{response:{status:200,content:{mimeType:'application/json',...content}}}]}}, meta);
  await expect(store.readHttpResponse(record.id)).rejects.toThrow();
});
it('批准命令保持固定 argv 字面量，只注入映射 env，cwd 在运行目录且不保存原输出', async () => {
  const {artifacts, redactor} = await setup();
  const runner = new ApprovedCommandRunner(artifacts, 'run-7', redactor, {env:{APPROVED:'value-secret',NOT_APPROVED:'hidden'}});
  const result = await runner.run({program:process.execPath,argv:['-e','console.log(JSON.stringify({arg:process.argv[1],v:process.env.INJECTED,other:process.env.NOT_APPROVED??null,cwd:process.cwd()}))','$(whoami) & echo injected'],env:{INJECTED:'APPROVED'}}, signal()) as any;
  expect(result).toMatchObject({arg:'$(whoami) & echo injected',v:'value-secret',other:null});
  expect(path.relative(artifacts.resolve('runs/run-7/commands'), result.cwd)).not.toMatch(/^\.\./);
  expect(redactor.text('value-secret')).toBe('[REDACTED]');
  expect(await artifacts.list('runs/run-7/commands')).toHaveLength(1);
});
it.each(['process.stdout.write("not-json")','console.error("raw-unknown-password");process.exit(2)','process.stdout.write("x".repeat(10000))'])('命令失败、非 JSON 或超限仅给固定错误 %s', async code => {
  const {artifacts, redactor} = await setup();
  const runner = new ApprovedCommandRunner(artifacts, 'run-7', redactor, {maxBytes:100});
  const failure = await runner.run({program:process.execPath,argv:['-e',code],env:{}}, signal()).catch(e => e);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as {kind:string}).kind).toMatch(/blocked|limit/);
  expect((failure as Error).message).not.toContain('raw-unknown-password');
});
it('命令硬截止真实终止等待，stderr 也计入总输出上限',async()=>{
  const {artifacts,redactor}=await setup();
  const runner=new ApprovedCommandRunner(artifacts,'run-7',redactor,{timeoutMs:200,maxBytes:50});
  await expect(runner.run({program:process.execPath,argv:['-e','setInterval(()=>{},1000)'],env:{}},signal())).rejects.toMatchObject({kind:'timeout'});
  await expect(runner.run({program:process.execPath,argv:['-e','process.stderr.write("x".repeat(500));console.log("{}")'],env:{}},signal())).rejects.toMatchObject({kind:'limit'});
});
it('已取消和缺少批准环境变量不会启动命令', async () => {
  const {artifacts,redactor} = await setup();
  const runner = new ApprovedCommandRunner(artifacts,'run-7',redactor,{env:{}});
  const controller = new AbortController(); controller.abort();
  await expect(runner.run({program:process.execPath,argv:[],env:{}},controller.signal)).rejects.toMatchObject({kind:'cancelled'});
  await expect(runner.run({program:process.execPath,argv:[],env:{X:'ABSENT'}},signal())).rejects.toMatchObject({kind:'blocked'});
  expect(await artifacts.list('runs/run-7/commands')).toEqual([]);
});
it('实际取消任务进程树，父子均结束且不误杀旁路进程', async () => {
  const {artifacts,redactor} = await setup();
  const {spawn} = await import('node:child_process');
  const unrelated = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const file = artifacts.resolve('pids.json');
  const code = 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(process.env.PID_FILE,JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)';
  const runner = new ApprovedCommandRunner(artifacts,'run-7',redactor,{env:{PID_FILE:file}});
  const controller = new AbortController();
  const running = runner.run({program:process.execPath,argv:['-e',code],env:{PID_FILE:'PID_FILE'}},controller.signal).catch(e=>e);
  let pids: number[] = [];
  try {
    for(let i=0;i<300;i++) { try { pids=JSON.parse(await readFile(file,'utf8')); break; } catch { await new Promise(r=>setTimeout(r,10)); } }
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(()=>process.kill(pid,0)).not.toThrow();
    controller.abort();
    expect(await running).toMatchObject({kind:'cancelled'});
    for(let i=0;i<100;i++) { if(pids.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}})) break; await new Promise(r=>setTimeout(r,10)); }
    for (const pid of pids) expect(()=>process.kill(pid,0)).toThrow();
    expect(()=>process.kill(unrelated.pid!,0)).not.toThrow();
  } finally { controller.abort(); unrelated.kill(); await running; }
}, 15000);
