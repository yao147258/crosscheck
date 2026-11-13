import { createProjectReader } from './files';
import type { DiscoveryPlugin, DiscoveryResult } from './types';

export async function discover({ projectRoot, plugins, signal }: {
  projectRoot: string;
  plugins: DiscoveryPlugin[];
  signal?: AbortSignal;
}): Promise<DiscoveryResult> {
  signal?.throwIfAborted();
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) throw new Error('插件 ID 重复');
    ids.add(plugin.id);
  }
  const files = createProjectReader(projectRoot);
  const result: DiscoveryResult = { facts: [], diagnostics: [] };
  for (const plugin of plugins) {
    signal?.throwIfAborted();
    try {
      const output = await plugin.scan({ files, signal });
      signal?.throwIfAborted();
      result.facts.push(...output.facts);
      result.diagnostics.push(...output.diagnostics);
    } catch {
      signal?.throwIfAborted();
      result.diagnostics.push({ plugin: plugin.id, message: '插件执行失败' });
    }
  }
  return result;
}
