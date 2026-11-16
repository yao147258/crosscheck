import { build } from 'esbuild';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2];
if (mode && !['--harness', '--approval'].includes(mode)) throw new Error('未知构建目标');
const production = !mode;
const entry = mode === '--approval' ? 'scripts/manual-approve.ts' : production ? 'packages/cli/src/index.ts' : 'packages/cli/test/harness.ts';
const outfile = mode === '--approval' ? 'packages/cli/dist/manual-approve.js' : production ? 'packages/cli/dist/index.js' : 'packages/cli/dist/test-harness.js';
const result = await build({
  absWorkingDir: root, entryPoints: [entry], outfile, bundle: true, packages: 'bundle', platform: 'node', format: 'esm', target: 'node22.12', metafile: true,
  plugins: [{ name: 'external-real-packages', setup(builder) {
    builder.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, args => {
      if (args.path.startsWith('@crosscheck/')) return;
      if (/^[A-Za-z]:[\\/]/.test(args.path)) return;
      return { path: args.path, external: true };
    });
  } }],
});
if (production && (Object.keys(result.metafile.inputs).some(name => /testing|ai[\\/]test|scripted-model/.test(name)) || Object.values(result.metafile.outputs).some(out => out.imports.some(i => i.path.startsWith('@crosscheck/') || i.path === 'ai/test')))) throw new Error('生产 bundle 包含测试模型或未构建 workspace 入口');
await chmod(new URL(`../${outfile}`, import.meta.url), 0o755);
await writeFile(new URL(`../${outfile}.meta.json`, import.meta.url), JSON.stringify(result.metafile, null, 2));
if (production && !(await readFile(new URL(`../${outfile}`, import.meta.url), 'utf8')).startsWith('#!/usr/bin/env node')) throw new Error('bin 缺失 shebang');
console.log(`构建完成 ${outfile}`);
