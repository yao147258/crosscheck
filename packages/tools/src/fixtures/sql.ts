import type { Fixture, Profile } from '@crosscheck/core';
import { createPgConnection, postgresConnectionIdentity, type PgConnection } from '../db/postgres';
import type { EvidenceRedactor } from '../evidence/redactor';

export class FixtureSqlError extends Error {
  constructor(readonly kind:'blocked'|'cancelled'|'timeout'|'limit') { super('批准 SQL 夹具未完成'); }
}
export interface FixtureSqlOptions { env:Record<string,string|undefined>; createConnection?:(url:string)=>PgConnection; sqlTimeoutMs?:number }
/** 只接受已确认 fixture；扩展协议和参数由底层 PgConnection 保证，不使用只读 Reader。 */
export async function executeFixtureSql(fixture:Extract<Fixture,{kind:'sql'}>, profile:Profile, redactor:EvidenceRedactor, signal:AbortSignal, options:FixtureSqlOptions):Promise<unknown[]> {
  const db=profile['data-model.yaml'];
  const query=Object.hasOwn(db.queries,fixture.query)?db.queries[fixture.query]:undefined;
  const readRef=db.connection?.env;
  const write=options.env[fixture.connection.env], read=readRef&&options.env[readRef];
  let readUser:string;
  try {
    if(!write||!read||fixture.connection.env===readRef||!query||query.parameters.length!==fixture.params.length)throw new Error();
    const writer=postgresConnectionIdentity(write), reader=postgresConnectionIdentity(read);
    // 保守拒绝相同用户名，即便 DNS 别名、端口或数据库不同也不能复用账号。
    if(writer.user===reader.user)throw new Error();
    readUser=reader.user;
    if(!query.parameters.every((p,i)=>fixture.params[i]===null?p.nullable:p.type==='json'||typeof fixture.params[i]===p.type))throw new Error();
  }catch{throw new FixtureSqlError('blocked');}
  if(signal.aborted)throw new FixtureSqlError('cancelled');
  const values=fixture.params.map((value,i)=>query!.parameters[i]!.type==='json'&&value!==null?JSON.stringify(value):value);
  redactor.addSecrets([write!,read!]);
  let client:PgConnection|undefined;
  let readClient:PgConnection|undefined;
  let kind:FixtureSqlError['kind']|undefined;
  const rows:unknown[]=[];let bytes=0;
  let stop!:()=>void;const stopped=new Promise<void>(resolve=>{stop=resolve;});
  const interrupt=(reason:FixtureSqlError['kind'])=>{kind??=reason;stop();};
  const abort=()=>interrupt('cancelled');signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>interrupt('timeout'),options.sqlTimeoutMs??15000);
  const run=async()=>{
    const factory=options.createConnection??createPgConnection;
    // 仅探测只读连接身份，不在它上面执行任何 fixture SQL。
    readClient=factory(read!);
    await readClient.connect();if(kind)return;
    const readIdentities=new Set([readUser]);
    let observedReadIdentity=false;
    await readClient.run('SELECT current_user, session_user',[],row=>{
      if(typeof row.current_user==='string'&&typeof row.session_user==='string'){
        readIdentities.add(row.current_user);readIdentities.add(row.session_user);observedReadIdentity=true;
      }
    });
    if(kind)return;
    if(!observedReadIdentity){interrupt('blocked');return;}
    client=factory(write!);
    if(client===readClient){interrupt('blocked');return;}
    await client.connect();if(kind)return;
    const exec=async(text:string,params:unknown[]=[],row:(v:Record<string,unknown>)=>void=()=>{})=>{if(kind)return;await client!.run(text,params,row);};
    await exec('BEGIN');
    await exec("SET LOCAL statement_timeout = '10000ms'");
    await exec("SET LOCAL lock_timeout = '2000ms'");
    let identitySafe=false;
    await exec('SELECT current_user, session_user',[],row=>{identitySafe=typeof row.current_user==='string'&&typeof row.session_user==='string'&&!readIdentities.has(row.current_user)&&!readIdentities.has(row.session_user);});
    if(kind)return;
    if(!identitySafe){interrupt('blocked');return;}
    await exec(query!.sql,values,row=>{
      if(kind)return;
      // pg row 是异步事件；外层 Promise catch 无法捕获这里的清洗异常。
      try {
        const clean=redactor.value(JSON.parse(JSON.stringify(row)));
        bytes+=Buffer.byteLength(JSON.stringify(clean));
        if(rows.length>=1000||bytes>256*1024){interrupt('limit');return;}
        rows.push(clean);
      } catch { interrupt('blocked'); }
    });
    if(!kind)await exec('COMMIT');
  };
  try { if(signal.aborted)interrupt('cancelled');else await Promise.race([run(),stopped]); }
  catch(error){kind??=error&&typeof error==='object'&&'code'in error&&['57014','55P03'].includes(String(error.code))?'timeout':'blocked';}
  finally {
    clearTimeout(timer);signal.removeEventListener('abort',abort);
    let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
    try { await Promise.race([Promise.all([...new Set([client,readClient].filter((c):c is PgConnection=>!!c))].map(c=>c.close())),new Promise<never>((_,reject)=>{cleanupTimer=setTimeout(()=>reject(new Error('准备连接清理超时')),2000);})]); }
    finally {clearTimeout(cleanupTimer);}
  }
  if(signal.aborted)kind='cancelled';
  if(kind)throw new FixtureSqlError(kind);
  return rows;
}
