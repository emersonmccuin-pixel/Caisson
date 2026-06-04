// Bundle the agent host. ONE RUNTIME (Step 7): this bundle is THE way the
// host runs — dev and packaged both spawn `node dist/host.mjs` as a supervised
// child of Electron main. `--watch` keeps rebuilding on change (dev-app.mjs).
//
// node-pty stays external (native addon): resolved from node_modules at
// runtime — declared in this package's deps so the walk-up from dist/ finds
// the repo's Node-ABI build in dev; packaged stages an Electron-ABI copy.

import { build, context } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const buildOptions = {
  entryPoints: [resolve(pkgRoot, 'src/cli.ts')],
  outfile: resolve(pkgRoot, 'dist/host.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['node-pty'],
  banner: {
    js: "import { createRequire as __pcCreateRequire } from 'node:module'; const require = __pcCreateRequire(import.meta.url);",
  },
  sourcemap: 'linked',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  console.log('[agent-host] watching src for changes (dist/host.mjs rebuilds on save)');
} else {
  await build(buildOptions);
}
