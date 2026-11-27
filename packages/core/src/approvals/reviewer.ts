import os from 'node:os';

/** 宿主核验后自动确认时写入确认记录的确认人；`review` 界面据此区分自动与人工确认。 */
export const AUTO_REVIEWER = 'auto';

/** 人工确认人：优先 CROSSCHECK_REVIEWER，其次系统用户名；拒绝空名称和保留身份。 */
export function resolveReviewer(
  env: Record<string, string | undefined> = process.env,
  userInfo: () => { username: string } = () => os.userInfo(),
): string {
  let name = env.CROSSCHECK_REVIEWER?.trim();
  if (!name) {
    try { name = userInfo().username.trim(); } catch { name = ''; }
  }
  if (!name) throw new Error('无法确定确认人：请设置环境变量 CROSSCHECK_REVIEWER');
  if (name === AUTO_REVIEWER) throw new Error(`确认人 ${AUTO_REVIEWER} 是自动确认的保留身份：请将 CROSSCHECK_REVIEWER 设为其他名称`);
  return name;
}
