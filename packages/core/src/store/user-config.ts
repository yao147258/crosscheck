import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { containsModelSecret, publicModelConfig, UserModelConfigSchema, type UserModelConfig } from '../schema/config';

/** 单独的用户配置读取边界，错误不附带文件内容或底层异常。 */
export async function loadUserModelConfig(home = os.homedir()): Promise<UserModelConfig> {
  let text: string;
  try { text = await readFile(path.join(home, '.crosscheck', 'config.yaml'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('找不到全局 ~/.crosscheck/config.yaml，请先配置模型和密钥');
    throw new Error('无法读取全局 ~/.crosscheck/config.yaml，请检查文件权限');
  }
  try {
    const config = UserModelConfigSchema.parse(YAML.parse(text));
    if (containsModelSecret(publicModelConfig(config), Object.values(config.providers).flatMap(provider => provider.apiKey ? [provider.apiKey] : []))) throw new Error();
    return config;
  } catch { throw new Error('全局 ~/.crosscheck/config.yaml 格式或配置不合法'); }
}
