import { z } from 'zod';
import { PROFILE_FILES, PROFILE_SCHEMAS, type ProfileFile } from '../schema/profile';
import type { ArtifactStore } from '../store/artifact-store';

export type ProfileFileState =
  | { name: ProfileFile; present: false }
  | { name: ProfileFile; present: true; ok: true; value: unknown }
  | { name: ProfileFile; present: true; ok: false; error: string };

/**
 * 读取并校验单个画像文件。value 是带默认值的解析结果，
 * 与 loadProfile 中对应文件的内容一致，确认哈希必须基于它计算。
 */
export async function readProfileFile(store: ArtifactStore, name: ProfileFile): Promise<ProfileFileState> {
  let raw: unknown;
  try {
    raw = await store.readYaml(`system/${name}`, z.unknown());
  } catch {
    return { name, present: true, ok: false, error: 'YAML 无法解析或文件无法读取' };
  }
  if (raw === undefined) return { name, present: false };
  const parsed = (PROFILE_SCHEMAS[name] as z.ZodType).safeParse(raw);
  return parsed.success
    ? { name, present: true, ok: true, value: parsed.data }
    : { name, present: true, ok: false, error: z.prettifyError(parsed.error) };
}

export async function readProfileFiles(store: ArtifactStore): Promise<ProfileFileState[]> {
  const result: ProfileFileState[] = [];
  for (const name of PROFILE_FILES) result.push(await readProfileFile(store, name));
  return result;
}
