export class ModelConfigError extends Error {
  override name = 'ModelConfigError';
}

/** 未写 [size] 后缀时的上下文窗口 */
export const DEFAULT_CONTEXT_WINDOW = 256_000;

const UNITS: Record<string, number> = { '': 1, k: 1_000, m: 1_000_000 };

/** 解析 provider:model[size]；只在第一个冒号处切分，可选的 [size] 后缀为上下文窗口，K/M 按 1000 进位 */
export function parseModelRef(ref: string): { provider: string; modelId: string; contextWindow: number } {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) throw new ModelConfigError(`模型引用格式应为 provider:model：${ref}`);
  let modelId = ref.slice(i + 1);
  let contextWindow = DEFAULT_CONTEXT_WINDOW;
  const suffix = /\[([^\]]*)\]$/.exec(modelId);
  if (suffix) {
    const size = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(suffix[1]!);
    contextWindow = size ? Math.round(Number(size[1]) * UNITS[size[2]!.toLowerCase()]!) : 0;
    modelId = modelId.slice(0, suffix.index);
    if (!modelId || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      throw new ModelConfigError(`模型引用的上下文窗口后缀不合法，应写成 model[256K] 或 model[1M]：${ref}`);
    }
  }
  return { provider: ref.slice(0, i), modelId, contextWindow };
}
