import { z } from 'zod';
import { isValidHostEntry } from '../guard/url-guard';

export const GuardrailsSchema = z.object({
  /** 允许访问的主机：`host`、`host:port` 或 `*.example.com` */
  allowedHosts: z.array(z.string().min(1).refine(isValidHostEntry, '主机格式不合法')).min(1, '必须至少登记一个允许的主机'),
  /** 禁止的请求：method 省略表示任意方法；path 支持 * 与 ** 通配 */
  forbidden: z
    .array(z.object({ method: z.string().optional(), path: z.string().min(1) }))
    .default([]),
  /** 需要额外脱敏的字段名（不区分大小写） */
  redactFields: z.array(z.string().min(1)).default([]),
});
export type Guardrails = z.infer<typeof GuardrailsSchema>;
