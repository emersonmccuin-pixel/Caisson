// Bundle the API server. ONE RUNTIME (Step 7): this bundle is THE way the API
// runs — dev and packaged both spawn `node dist/server.mjs` as a supervised
// child of Electron main. Dev's speed comes from `--watch` rebuilding this
// file, not from a second way of running the app.
//
// Output: apps/server/dist/server.mjs (ESM, top-level await preserved).
// Native modules stay external: resolved from node_modules at runtime —
// dev = the repo's Node-ABI builds (declared in this package's deps so the
// walk-up from dist/ finds them), packaged = staged Electron-ABI rebuilds.
//
// `--watch` keeps rebuilding on change (run by scripts/dev-app.mjs).

import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const buildOptions = {
  entryPoints: [resolve(pkgRoot, 'src/index.ts')],
  outfile: resolve(pkgRoot, 'dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Native addons can't be bundled — keep them as runtime imports resolved
  // from node_modules (dev: repo Node-ABI; packaged: Electron-ABI restage).
  external: ['better-sqlite3', 'node-pty'],
  // ESM output bundling CJS deps (ws does `require('events')`) needs a real
  // `require` in scope so esbuild's require-shim resolves Node builtins instead
  // of throwing "Dynamic require of … is not supported".
  banner: {
    js: "import { createRequire as __pcCreateRequire } from 'node:module'; const require = __pcCreateRequire(import.meta.url);",
  },
  sourcemap: 'linked',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  console.log('[server] watching src for changes (dist/server.mjs rebuilds on save)');
} else {
  await build(buildOptions);
}
