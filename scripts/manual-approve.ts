import { ArtifactStore, Approvals, loadProfile } from '../packages/core/src/index';

// 人工先逐项审阅所有输入，再显式运行本脚本；run 永不导入或调用本脚本。
const [project, by, confirmation, ...extra] = process.argv.slice(2);
if (!project || !by || confirmation !== '我已逐项审阅并确认' || extra.length) {
  console.error('用法：node packages/cli/dist/manual-approve.js <项目目录> <审核人> 我已逐项审阅并确认');
  process.exitCode = 2;
} else {
  try {
    const store = new ArtifactStore(project);
    const profile = await loadProfile(store);
    const modules = [...new Set([...await store.listModules('requirements'), ...await store.listModules('cases')])];
    const clauses = (await Promise.all(modules.map(module => store.loadClauses(module)))).flat();
    const cases = (await Promise.all(modules.map(module => store.loadCases(module)))).flat();
    const approvals = await Approvals.load(store);
    for (const [name, value] of Object.entries(profile)) approvals.approve('profile', name, value, by);
    for (const clause of clauses) approvals.approve('clause', clause.id, clause, by);
    for (const tc of cases) approvals.approveCase(tc, clauses, by);
    await approvals.save(store);
    console.log(`人工确认已保存：七画像、${clauses.length} 条款、${cases.length} 用例。运行尚未开始。`);
  } catch { console.error('输入读取、校验或确认保存失败；请先修正手工输入'); process.exitCode = 3; }
}
