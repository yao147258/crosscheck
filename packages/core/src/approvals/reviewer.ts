import os from 'node:os';

/** 确认人：优先 CROSSCHECK_REVIEWER，其次系统用户名；都拿不到时拒绝 */
export function resolveReviewer(
  env: Record<string, string | undefined> = process.env,
  userInfo: () => { username: string } = () => os.userInfo(),
): string {
  const fromEnv = env.CROSSCHECK_REVIEWER?.trim();
  if (fromEnv) return fromEnv;
  let name = '';
  try { name = userInfo().username.trim(); } catch { name = ''; }
  if (!name) throw new Error('无法确定确认人：请设置环境变量 CROSSCHECK_REVIEWER');
  return name;
}
