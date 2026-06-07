// Section 10 Phase 1.5 — electron-builder strips `node_modules` from
// extraResources copies (it assumes it owns dependency collection). The
// packaged server bundle needs its native externals (better-sqlite3 rebuilt
// for Electron's ABI + node-pty's N-API prebuilds), so copy the staged
// node_modules into the packed app ourselves, after packing.

const { cpSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

exports.default = async function afterPack(context) {
  const src = resolve(__dirname, '..', 'staging', 'pcserver', 'node_modules');
  if (!existsSync(src)) {
    throw new Error(`[afterPack] staged node_modules missing — run \`pnpm stage && pnpm rebuild:native\` first (${src})`);
  }
  // Resources live at a platform-specific path inside the packed app:
  //   macOS:      <appOutDir>/<Product>.app/Contents/Resources
  //   win/linux:  <appOutDir>/resources
  // The old Windows-only hardcode (`<appOutDir>/resources`) put the native
  // node_modules NEXT TO the .app on macOS instead of inside it, so the shipped
  // bundle had no node-pty → agent-host ERR_MODULE_NOT_FOUND crash-loop on every
  // fresh Mac launch (pc-pty-chat-293). Derive the path from the platform.
  const resourcesDir =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources');
  const dest = join(resourcesDir, 'pcserver', 'node_modules');
  cpSync(src, dest, { recursive: true, dereference: true });
  console.log('[afterPack] copied server node_modules →', dest);
};
