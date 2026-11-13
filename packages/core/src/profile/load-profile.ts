import { z } from 'zod';
import { PROFILE_FILES, ProfileSchema, type Profile } from '../schema/profile';
import { ArtifactError, type ArtifactStore } from '../store/artifact-store';

/** 固定加载七个文件，显式空配置合法，但缺文件不合法。 */
export async function loadProfile(store: ArtifactStore): Promise<Profile> {
  const files: Record<string, unknown> = {};
  for (const name of PROFILE_FILES) {
    const value = await store.readYaml(`system/${name}`, z.unknown());
    if (value === undefined) throw new ArtifactError(`缺少必需系统画像：system/${name}`);
    files[name] = value;
  }
  const parsed = ProfileSchema.safeParse(files);
  if (!parsed.success) throw new ArtifactError(`系统画像不合法：${parsed.error.message}`);
  return parsed.data;
}
