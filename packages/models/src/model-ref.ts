export class ModelConfigError extends Error {
  override name = 'ModelConfigError';
}

/** 解析 provider:model；只在第一个冒号处切分 */
export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) throw new ModelConfigError(`模型引用格式应为 provider:model：${ref}`);
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}
