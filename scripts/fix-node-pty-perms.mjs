// node-pty ships its unix `spawn-helper` as a prebuilt binary. pnpm's
// content-addressable extraction can land it WITHOUT the execute bit, so
// node-pty's `posix_spawnp` of the helper fails at runtime with the opaque
// "Error: posix_spawnp failed." — and because PC spawns claude.exe through a
// PTY, every orchestrator/agent run dies before producing a byte ("agent host
// reported the chat run failed", empty transcript). Restore +x on every
// spawn-helper under node_modules after each install. Idempotent, best-effort.

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const nodeModules = join(root, 'node_modules');

let fixed = 0;
let scanned = 0;

/** Walk node_modules looking for files named `spawn-helper` and chmod +x. */
function walk(dir, depth = 0) {
  // Bound the walk: spawn-helper lives at node-pty/{build/Release,prebuilds/*}.
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, depth + 1);
    } else if (entry.name === 'spawn-helper') {
      scanned += 1;
      try {
        const mode = statSync(full).mode;
        if ((mode & 0o111) !== 0o111) {
          chmodSync(full, mode | 0o755);
          fixed += 1;
        }
      } catch {
        /* best-effort */
      }
    }
  }
}

if (existsSync(nodeModules)) {
  walk(nodeModules);
}

if (fixed > 0) {
  console.log(`[fix-node-pty-perms] restored +x on ${fixed}/${scanned} spawn-helper binaries`);
}
