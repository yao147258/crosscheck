import { z } from 'zod';
import { validateHeaderName, validateHeaderValue } from 'node:http';
const forbidden = new Set(['host','content-length','transfer-encoding','connection','upgrade','trailer','te','expect','proxy-authorization']);
export const AuthHeadersSchema = z.strictObject({headers:z.record(z.string(),z.string())}).superRefine((value,ctx)=>{
  const names = new Set<string>();
  for (const [name,text] of Object.entries(value.headers)) {
    try {
      validateHeaderName(name); validateHeaderValue(name,text);
      const key=name.toLowerCase();
      if(forbidden.has(key) || names.has(key) || !text || /[\r\n\u0000]/.test(text)) throw new Error();
      names.add(key);
    } catch { ctx.addIssue({code:'custom',message:'认证头不合法'}); }
  }
});
