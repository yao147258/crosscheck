import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { sanitize } from './sanitize';
import type { DiscoveryFact, DiscoveryPlugin, DiscoveryResult, DiscoverySource } from './types';

const id = 'static';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);

// 仅接受受限 XML 子集；不解析或展开实体、DTD、CDATA。
function validPomXml(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (!(code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) return false;
  }
  const stack: string[] = [];
  let position = 0;
  let roots = 0;
  let declaration = false;
  const validReferences = (value: string): boolean => {
    const reference = /&(?:amp;|lt;|gt;|quot;|apos;|#(\d+);|#x([\da-fA-F]+);)/gy;
    let pos = value.indexOf('&');
    while (pos !== -1) {
      reference.lastIndex = pos;
      const match = reference.exec(value);
      if (!match) return false;
      if (match[1] !== undefined || match[2] !== undefined) {
        const code = match[1] !== undefined ? Number(match[1]) : parseInt(match[2]!, 16);
        if (!(code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) return false;
      }
      pos = value.indexOf('&', reference.lastIndex);
    }
    return true;
  };
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[A-Za-z_:][\w:.-]*(?:[\x20\x09\x0d\x0a]+(?:[^"'<>]|"[^"<]*"|'[^'<]*')*)?[\x20\x09\x0d\x0a]*\/?>|[^<]+/gy;
  while (position < text.length) {
    token.lastIndex = position;
    const match = token.exec(text);
    if (!match) return false;
    const part = match[0];
    position = token.lastIndex;
    if (part.startsWith('<!--')) {
      if (part.slice(4, -3).includes('--')) return false;
    } else if (part.startsWith('<?')) {
      if (!/^<\?xml[\x20\x09\x0d\x0a]+version[\x20\x09\x0d\x0a]*=[\x20\x09\x0d\x0a]*(?:"1\.0"|'1\.0')(?:[\x20\x09\x0d\x0a]+encoding[\x20\x09\x0d\x0a]*=[\x20\x09\x0d\x0a]*(?:"UTF-8"|'UTF-8'))?(?:[\x20\x09\x0d\x0a]+standalone[\x20\x09\x0d\x0a]*=[\x20\x09\x0d\x0a]*(?:"(?:yes|no)"|'(?:yes|no)'))?[\x20\x09\x0d\x0a]*\?>$/.test(part) || declaration || position !== part.length || roots || stack.length) return false;
      declaration = true;
    } else if (part.startsWith('</')) {
      const closing = /^<\/([A-Za-z_:][\w:.-]*)[\x20\x09\x0d\x0a]*>$/.exec(part);
      if (!closing || stack.pop() !== closing[1]) return false;
    } else if (part.startsWith('<')) {
      const opening = /^<([A-Za-z_:][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(part);
      if (!opening) return false;
      const attrs = opening[2]!;
      const attr = /[\x20\x09\x0d\x0a]+([A-Za-z_:][\w:.-]*)[\x20\x09\x0d\x0a]*=[\x20\x09\x0d\x0a]*(?:"([^"<]*)"|'([^'<]*)')/gy;
      let at = 0;
      const names = new Set<string>();
      while (at < attrs.length && !/^[\x20\x09\x0d\x0a]*$/.test(attrs.slice(at))) {
        attr.lastIndex = at;
        const found = attr.exec(attrs);
        if (!found || names.has(found[1]!) || !validReferences(found[2] ?? found[3] ?? '')) return false;
        names.add(found[1]!);
        at = attr.lastIndex;
      }
      if (!stack.length && (++roots !== 1 || opening[1] !== 'project')) return false;
      if (!opening[3]) stack.push(opening[1]!);
    } else if ((!stack.length && !/^[\x20\x09\x0d\x0a]*$/.test(part)) || !validReferences(part) || part.includes(']]>')) return false;
  }
  return roots === 1 && stack.length === 0;
}

export const staticScanPlugin: DiscoveryPlugin = {
  id,
  async scan({ files, signal }) {
    const result: DiscoveryResult = { facts: [], diagnostics: [] };
    const diagnostic = (file: string) => result.diagnostics.push({ plugin: id, file, message: '文件格式无效或包含不支持的内容' });
    for (const file of ['README.md', 'package.json', 'pom.xml', 'compose.yaml', 'docker-compose.yml', '.env.example']) {
      signal?.throwIfAborted();
      try {
        const text = await files.readText(file, signal);
        signal?.throwIfAborted();
        if (text === undefined) continue;
        const lines = text.split(/\r?\n/);
        const source = (line: number, excerpt: string): DiscoverySource => ({ file, line, excerpt: sanitize(excerpt) });
        const add = (fact: DiscoveryFact) => result.facts.push(fact);
        if (file === 'README.md') {
          lines.forEach((line, i) => {
            if (/\b(?:npm|pnpm|yarn|bun|docker(?:-compose)?|mvn|gradle)\s+(?:run\s+)?(?:start|dev|serve|up|spring-boot:run)\b|启动|运行/i.test(line)) {
              const clean = sanitize(line.trim());
              if (clean) add({ kind: 'command', plugin: id, name: `README:${i + 1}`, command: clean, source: source(i + 1, line.trim()) });
            }
          });
        } else if (file === 'package.json') {
          const data: unknown = JSON.parse(text);
          if (!object(data)) { diagnostic(file); continue; }
          const document = parseDocument(text, { uniqueKeys: false });
          if (document.errors.length) { diagnostic(file); continue; }
          const keyLine = (...path: string[]): number | undefined => {
            let node: unknown = document.contents;
            for (const [index, part] of path.entries()) {
              if (!isMap(node)) return undefined;
              const pair = [...node.items].reverse().find(item => isScalar(item.key) && item.key.value === part);
              if (!pair || !isScalar(pair.key)) return undefined;
              if (index === path.length - 1) {
                const offset = pair.key.range?.[0];
                return offset === undefined ? undefined : text.slice(0, offset).split('\n').length;
              }
              node = pair.value;
            }
            return undefined;
          };
          if (validName(data.name)) {
            const name = sanitize(data.name);
            const projectLine = keyLine('name');
            if (projectLine === undefined) { diagnostic(file); continue; }
            const src = source(projectLine, data.name);
            add({ kind: 'project', plugin: id, ecosystem: 'npm', name, source: src });
            for (const framework of ['express', 'fastify', 'koa', 'next', 'react', 'vue', 'vite', '@nestjs/core']) {
              const section = ['dependencies', 'devDependencies', 'peerDependencies'].find(key => object(data[key]) && Object.hasOwn(data[key], framework));
              if (section) {
                const line = keyLine(section, framework);
                if (line === undefined) { diagnostic(file); continue; }
                add({ kind: 'project', plugin: id, ecosystem: `node:${framework}`, name, source: source(line, framework) });
              }
            }
          } else diagnostic(file);
          if (data.scripts !== undefined && !object(data.scripts)) diagnostic(file);
          if (object(data.scripts)) for (const [name, command] of Object.entries(data.scripts)) {
            if (!validName(name) || !validName(command)) { diagnostic(file); continue; }
            const line = keyLine('scripts', name);
            if (line === undefined) { diagnostic(file); continue; }
            const property = `${JSON.stringify(name)}: ${JSON.stringify(command)}`;
            const excerpt = lines[line - 1]!.includes(property) ? property : command;
            add({ kind: 'command', plugin: id, name: sanitize(name), command: sanitize(command), source: source(line, excerpt) });
          }
        } else if (file === '.env.example') {
          const seen = new Set<string>();
          lines.forEach((line, i) => {
            const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
            if (!match || seen.has(match[1]!)) return;
            const name = match[1]!;
            seen.add(name);
            add({ kind: 'environment-variable', plugin: id, name, source: { file, line: i + 1, excerpt: `${name}=[已隐藏]` } });
          });
        } else if (file === 'pom.xml') {
          if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text) || !validPomXml(text)) { diagnostic(file); continue; }
          const withoutComments = text.replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\r\n]/g, ' '));
          if (!/<project(?:\s[^>]*)?>[\s\S]*<\/project\s*>/i.test(withoutComments)) { diagnostic(file); continue; }
          const projectPart = withoutComments.replace(/<(parent|dependencies|dependencyManagement|build|profiles|reporting|repositories|pluginRepositories|properties)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, match => match.replace(/[^\r\n]/g, ' '));
          const match = /<artifactId\s*>\s*([^<>&\s]+)\s*<\/artifactId\s*>/i.exec(projectPart);
          if (!match) { diagnostic(file); continue; }
          const name = sanitize(match[1]!);
          const src = source(projectPart.slice(0, match.index).split('\n').length, match[0]);
          add({ kind: 'project', plugin: id, ecosystem: 'maven', name, source: src });
          const spring = /<artifactId\s*>\s*(spring-boot-starter(?:-parent|-[\w.-]+)?)\s*<\/artifactId\s*>/i.exec(withoutComments);
          if (spring) add({ kind: 'project', plugin: id, ecosystem: 'spring-boot', name, source: source(withoutComments.slice(0, spring.index).split('\n').length, spring[0]) });
        } else {
          const document = parseDocument(text, { uniqueKeys: true, strict: true });
          if (document.errors.length) { diagnostic(file); continue; }
          const data: unknown = document.toJS({ maxAliasCount: 100 });
          if (!object(data) || !object(data.services)) { diagnostic(file); continue; }
          const portNumber = (raw: unknown): number => {
            const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
            return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : NaN;
          };
          for (const [service, config] of Object.entries(data.services)) {
            if (!validName(service) || !object(config)) { diagnostic(file); continue; }
            if (config.ports === undefined) continue;
            const portsNode = document.getIn(['services', service, 'ports'], true);
            if (!Array.isArray(config.ports) || !isSeq(portsNode)) { diagnostic(file); continue; }
            for (const [index, entry] of config.ports.entries()) {
              let raw: unknown;
              if (typeof entry === 'string' || typeof entry === 'number') {
                const match = /^(?:(?:\d{1,3}\.){3}\d{1,3}:)?(?:(\d+):)?(\d+)(?:\/(?:tcp|udp))?$/.exec(String(entry));
                if (!match || [match[1], match[2]].some(part => part !== undefined && Number.isNaN(portNumber(part)))) { diagnostic(file); continue; }
                raw = match[1] ?? match[2];
              } else if (object(entry)) {
                if (Number.isNaN(portNumber(entry.target)) || (Object.hasOwn(entry, 'published') && Number.isNaN(portNumber(entry.published)))) { diagnostic(file); continue; }
                raw = Object.hasOwn(entry, 'published') ? entry.published : entry.target;
              } else { diagnostic(file); continue; }
              const value = portNumber(raw);
              if (Number.isNaN(value)) { diagnostic(file); continue; }
              // 来源绑定当前服务的具体 ports 项；别名等无法直接定位的结构保守跳过。
              const node = portsNode.items[index];
              const offset = isScalar(node) || isMap(node) ? node.range?.[0] : undefined;
              if (offset === undefined) { diagnostic(file); continue; }
              const line = text.slice(0, offset).split('\n').length;
              add({ kind: 'port', plugin: id, port: value, service: sanitize(service), source: source(line, lines[line - 1]!.trim()) });
            }
          }
        }
      } catch {
        signal?.throwIfAborted();
        diagnostic(file);
      }
    }
    signal?.throwIfAborted();
    return result;
  },
};
