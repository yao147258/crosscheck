import { defineTool } from '@crosscheck/agent';
import type { EvidenceMeta } from '../network/http-client';
import { BrowserActionSchema, BrowserHost, BrowserOperationError } from './actions';

export function createBrowserTools(host: BrowserHost, nextMeta: () => EvidenceMeta) {
  return [defineTool({
    name: 'browser_action', category: 'browser', description: '执行结构化浏览器动作并采集遮罩截图、DOM、网络和 console；不支持脚本、文件或启动参数', input: BrowserActionSchema,
    async execute(action, context) {
      try { return await host.perform(action, nextMeta(), context.signal); }
      catch (error) {
        if (error instanceof BrowserOperationError) return { error: { kind: error.kind, message: error.message }, evidenceIds: error.evidenceIds };
        throw error;
      }
    },
  })];
}
