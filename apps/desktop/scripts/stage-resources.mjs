// Section 10 Phase 1.5 — assemble the packaged server resource tree.
//
// electron-builder ships this dir as `extraResources` → `<resources>/pcserver/`.
// The desktop main process sets PC_ROOT to it, so the server's ROOT-relative
// path resolution (apps/web/dist, templates, packages/mcp/dist) lands here
// unchanged. Layout mirrors the repo's sub-paths:
//
//   pcserver/
//     server.mjs                     bundled API server
//     agent-host.mjs                 bundled out-of-process agent host
//     apps/web/dist/                 web UI (PUBLIC)
//     templates/                     project scaffold templates
//     packages/mcp/dist/server.mjs   pc-rig MCP server (self-contained; spawned)
//     node_modules/                  server externals (better-sqlite3, node-pty)
//
// Native deps are the only non-bundled pieces: node-pty ships N-API prebuilds
// (ABI-stable, copied as-is); better-sqlite3 is V8-ABI and gets rebuilt for
// Electron by rebuild-native.mjs after this stages it.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRUNK = resolve(__dirname, '..', '..', '..');
const STAGING = resolve(__dirname, '..', 'staging');
const OUT = join(STAGING, 'pcserver');

rmSync(STAGING, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// dereference: pnpm stores deps as symlinks into `.pnpm`; the staged tree must
// be real files (Windows can't recreate the symlinks unprivileged, and the
// packaged app must be self-contained).
const copy = (from, to) => cpSync(from, join(OUT, to), { recursive: true, dereference: true });

function packageRoot(anchorRequire, name) {
  return dirname(anchorRequire.resolve(`${name}/package.json`));
}

function readPackageVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  return pkg.version;
}

// 1. server bundle
copy(resolve(TRUNK, 'apps/server/dist/server.mjs'), 'server.mjs');
copy(resolve(TRUNK, 'apps/server/dist/server.mjs.map'), 'server.mjs.map');
copy(resolve(TRUNK, 'packages/agent-host/dist/host.mjs'), 'agent-host.mjs');
copy(resolve(TRUNK, 'packages/agent-host/dist/host.mjs.map'), 'agent-host.mjs.map');

// 2. web UI
copy(resolve(TRUNK, 'apps/web/dist'), 'apps/web/dist');

// 3. scaffold templates
copy(resolve(TRUNK, 'templates'), 'templates');

// 3b. Drizzle migrations (read at runtime by runMigrations via ROOT-relative path)
copy(resolve(TRUNK, 'packages/db/drizzle'), 'packages/db/drizzle');

// 4. pc-rig MCP server (self-contained bundle)
copy(resolve(TRUNK, 'packages/mcp/dist/server.mjs'), 'packages/mcp/dist/server.mjs');
copy(resolve(TRUNK, 'packages/mcp/dist/server.mjs.map'), 'packages/mcp/dist/server.mjs.map');

// ☠ FD-3: the channel-server bundle step is gone with the channel system.

// 6. native externals for the server bundle
const NM = 'node_modules';
const runtimeRequire = createRequire(resolve(TRUNK, 'packages/runtime/package.json'));
const dbRequire = createRequire(resolve(TRUNK, 'packages/db/package.json'));
const nodePtyRoot = packageRoot(runtimeRequire, 'node-pty');
const betterSqliteRoot = packageRoot(dbRequire, 'better-sqlite3');
const betterSqliteRequire = createRequire(join(betterSqliteRoot, 'package.json'));
const bindingsRoot = packageRoot(betterSqliteRequire, 'bindings');
const prebuildInstallRoot = packageRoot(betterSqliteRequire, 'prebuild-install');
const bindingsRequire = createRequire(join(bindingsRoot, 'package.json'));
const fileUriToPathRoot = packageRoot(bindingsRequire, 'file-uri-to-path');

copy(nodePtyRoot, join(NM, 'node-pty'));
copy(betterSqliteRoot, join(NM, 'better-sqlite3'));
copy(bindingsRoot, join(NM, 'bindings'));
copy(prebuildInstallRoot, join(NM, 'prebuild-install'));
copy(fileUriToPathRoot, join(NM, 'file-uri-to-path'));

// 7. package.json declaring the native deps — @electron/rebuild walks this
// dependency graph to find what to rebuild; without the deps listed it
// silently no-ops and the Node-ABI binary ships (NODE_MODULE_VERSION mismatch
// at runtime). Versions mirror the staged copies.
writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: 'pcserver',
      version: '0.0.0',
      private: true,
      dependencies: {
        'better-sqlite3': readPackageVersion(betterSqliteRoot),
        'node-pty': readPackageVersion(nodePtyRoot),
      },
    },
    null,
    2,
  ) + '\n',
);

console.log('staged →', OUT);
