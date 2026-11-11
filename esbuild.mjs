import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', sourcemap: false, logLevel: 'info' };
const builds = [
  { ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/hook.ts'], outfile: 'dist/hook.js' },
  { ...common, entryPoints: ['src/mcp.ts'], outfile: 'dist/mcp.js' },
  { ...common, entryPoints: ['src/uninstall.ts'], outfile: 'dist/uninstall.js' },
  // Used by the Visual Studio extension (visualstudio/), not by VS Code.
  { ...common, entryPoints: ['src/vs-bridge.ts'], outfile: 'dist/vs-bridge.js' },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
