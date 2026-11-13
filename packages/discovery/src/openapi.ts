import { isMap, isScalar, LineCounter, parseDocument } from 'yaml';
import { sanitize, unescapeSlashes } from './sanitize';
import type { DiscoveryFact, DiscoveryPlugin, DiscoveryResult } from './types';

const id = 'openapi';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
// 先把 "/" 的转义写法还原成字面字符，再做基于字面 "//" 的识别；否则像
// "/api\/\/user:secret@…" 这类原始文本会绕过下面的正则（见 sanitize.ts 的说明）。
const clean = (text: string) => sanitize(unescapeSlashes(text).replace(/(?<!:)\/\/[^\s"'<>\\]+/g, value => {
  // 不规范化普通路径的内部双斜杠；仅在含用户信息、查询或片段时清理。
  // 先去掉全部连续的前导斜杠再判断用户信息：一个额外的前导斜杠就会让
  // 只认两条斜杠的正则漏判，使凭证原样保留在来源摘录里（见该行上游 path
  // 校验永远按原文检查，但 excerpt/summary 等字段都要过这同一个清理函数）。
  const leading = /^\/+/.exec(value)![0];
  const rest = value.slice(leading.length);
  const hasUserinfo = /^[^/?#]*@/.test(rest);
  const hasQueryOrHash = /[?#]/.test(value);
  if (!hasUserinfo && !hasQueryOrHash) return value;
  // 前导斜杠不是恰好两条时不是合法的协议相对 URL，new URL() 的归一化行为
  // 不可信；直接整体隐藏，不尝试拼回部分内容。
  if (hasUserinfo && leading.length !== 2) return '[已隐藏URL]';
  try {
    const url = new URL(`https:${value}`);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString().slice(6);
  } catch { return '[已隐藏URL]'; }
}));
type Parameter = Extract<DiscoveryFact, { kind: 'api' }>['parameters'][number];

export function openApiPlugin(files: string[]): DiscoveryPlugin {
  return { id, async scan({ files: reader, signal }) {
    const result: DiscoveryResult = { facts: [], diagnostics: [] };
    for (const file of new Set(files)) {
      signal?.throwIfAborted();
      const diagnostic = () => result.diagnostics.push({ plugin: id, file: sanitize(file), message: 'OpenAPI 文件包含无效或不支持的内容' });
      try {
        const text = await reader.readText(file, signal);
        signal?.throwIfAborted();
        if (text === undefined) continue;
        const counter = new LineCounter();
        const doc = parseDocument(text, { lineCounter: counter, uniqueKeys: true, strict: true });
        if (doc.errors.length) { diagnostic(); continue; }
        const data: unknown = doc.toJS({ maxAliasCount: 100 });
        if (!object(data) || !(typeof data.openapi === 'string' && /^3\.[01]\.\d+$/.test(data.openapi) || data.swagger === '2.0') || !object(data.paths)) { diagnostic(); continue; }
        const swagger = data.swagger === '2.0';
        const resolve = (input: unknown): unknown => {
          let value = input;
          const seen = new Set<string>();
          while (object(value) && Object.hasOwn(value, '$ref')) {
            if (Object.keys(value).length !== 1 || typeof value.$ref !== 'string' || !value.$ref.startsWith('#') || seen.size >= 32) throw new Error();
            const ref = decodeURIComponent(value.$ref.slice(1));
            if (!ref.startsWith('/') || seen.has(ref)) throw new Error();
            seen.add(ref);
            let target: unknown = data;
            for (const part of ref.slice(1).split('/')) {
              if (/~(?![01])/.test(part)) throw new Error();
              const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
              if ((!object(target) && !Array.isArray(target)) || !Object.hasOwn(target, key)) throw new Error();
              target = (target as Record<string, unknown>)[key];
            }
            value = target;
          }
          return value;
        };
        const parameters = (input: unknown): Parameter[] => {
          if (input === undefined) return [];
          if (!Array.isArray(input)) throw new Error();
          const list: Parameter[] = [];
          for (const entry of input) {
            const p = resolve(entry);
            if (!object(p) || !name(p.name) || !name(p.in) || !(swagger ? ['path', 'query', 'header', 'body', 'formData'] : ['path', 'query', 'header', 'cookie']).includes(p.in) || (p.required !== undefined && typeof p.required !== 'boolean') || (p.in === 'path' && p.required !== true)) throw new Error();
            let type: unknown = p.type;
            if (p.schema !== undefined) {
              const schema = resolve(p.schema);
              if (!object(schema)) throw new Error();
              type = schema.type;
            }
            if (type !== undefined && !name(type)) throw new Error();
            if (list.some(item => item.name === p.name && item.in === p.in)) throw new Error();
            list.push({ name: p.name, in: p.in, required: p.required === true, ...(type === undefined ? {} : { type: type as string }) });
          }
          return list;
        };
        const servers = (value: unknown): string[] => {
          if (!Array.isArray(value)) throw new Error();
          return value.map(entry => {
            if (!object(entry) || !name(entry.url)) throw new Error();
            const url = entry.url.replace(/\{([^{}]+)\}/g, (_match, variable: string) => {
              if (!object(entry.variables) || !Object.hasOwn(entry.variables, variable) || !object(entry.variables[variable]) || typeof entry.variables[variable].default !== 'string') throw new Error();
              return entry.variables[variable].default as string;
            });
            if (/[{}]/.test(url)) throw new Error();
            return clean(url.split(/[?#]/, 1)[0]!);
          });
        };
        for (const [path, rawItem] of Object.entries(data.paths)) {
          signal?.throwIfAborted();
          if (path.startsWith('x-')) continue;
          if (!path.startsWith('/') || path.startsWith('//') || /[?#]/.test(path) || /\/\/[^/\s]*@/.test(path)) { diagnostic(); continue; }
          let item: unknown;
          try { item = resolve(rawItem); } catch { diagnostic(); continue; }
          if (!object(item)) { diagnostic(); continue; }
          for (const [method, operation] of Object.entries(item)) {
            signal?.throwIfAborted();
            if (!methods.has(method)) {
              if (!['parameters', 'servers', 'summary', 'description', '$ref'].includes(method) && !method.startsWith('x-')) diagnostic();
              continue;
            }
            try {
              if (!object(operation) || (operation.summary !== undefined && typeof operation.summary !== 'string')) throw new Error();
              const merged = parameters(item.parameters);
              for (const param of parameters(operation.parameters)) {
                const index = merged.findIndex(p => p.name === param.name && p.in === param.in);
                if (index < 0) merged.push(param); else merged[index] = param;
              }
              const template = [...path.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!);
              if (/[{}]/.test(path.replace(/\{[^{}]+\}/g, '')) || template.some(key => !merged.some(p => p.in === 'path' && p.name === key)) || merged.some(p => p.in === 'path' && !template.includes(p.name))) throw new Error();
              let serverList: string[] = [];
              if (swagger) {
                if (data.basePath !== undefined && (typeof data.basePath !== 'string' || !data.basePath.startsWith('/'))) throw new Error();
                if (typeof data.basePath === 'string') serverList = [sanitize(data.basePath.split(/[?#]/, 1)[0]!)];
              } else {
                const owner = Object.hasOwn(operation, 'servers') ? operation : Object.hasOwn(item, 'servers') ? item : data;
                if (Object.hasOwn(owner, 'servers')) serverList = servers(owner.servers);
              }
              const pathNode = doc.getIn(['paths', path], true);
              let offset: number | undefined;
              if (isMap(pathNode)) {
                const pair = pathNode.items.find(pair => isScalar(pair.key) && pair.key.value === method);
                if (pair && isScalar(pair.key)) offset = pair.key.range?.[0];
                if (offset === undefined && isScalar(pathNode.items[0]?.key)) offset = pathNode.items[0].key.range?.[0];
              }
              if (offset === undefined) throw new Error();
              const line = counter.linePos(offset).line;
              const excerpt = text.split(/\r?\n/)[line - 1]?.trim();
              if (excerpt === undefined) throw new Error();
              result.facts.push({ kind: 'api', plugin: id, method: method.toUpperCase(), path: sanitize(path), summary: clean(operation.summary ?? ''), parameters: merged.map(p => ({ ...p, name: clean(p.name), in: clean(p.in), ...(p.type === undefined ? {} : { type: clean(p.type) }) })), servers: serverList, source: { file: clean(file), line, excerpt: clean(excerpt) } });
            } catch { diagnostic(); }
          }
        }
      } catch { signal?.throwIfAborted(); diagnostic(); }
    }
    signal?.throwIfAborted();
    return result;
  } };
}
