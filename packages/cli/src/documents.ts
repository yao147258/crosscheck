import path from 'node:path';
import { createProjectReader } from '@crosscheck/discovery';
import type { RequirementDocument } from '@crosscheck/requirements';

/** 使用项目安全读取器拒绝链接、凭证和超大文件，来源统一为正斜线相对路径。 */
export async function readRequirementDocuments(projectRoot: string, files: string[], signal?: AbortSignal): Promise<RequirementDocument[]> {
  const reader = createProjectReader(projectRoot);
  const documents: RequirementDocument[] = [];
  let totalBytes = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    // 先校验原路径，不能通过规范化抹掉父路径或凭证路径组件。
    // 单次限额读取先保留真实宿主错误，避免读取器用同时发生的取消覆盖它。
    const text = await reader.readText(file);
    signal?.throwIfAborted();
    if (text === undefined) throw new Error(`需求文档不存在：${file}`);
    totalBytes += Buffer.byteLength(text, 'utf8');
    if (totalBytes > 2 * 1024 * 1024) throw new Error('需求文档总大小超出 2 MiB 限制');
    documents.push({ file: path.posix.normalize(file.replaceAll('\\', '/')), text });
  }
  return documents;
}
