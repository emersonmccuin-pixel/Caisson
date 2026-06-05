// Section 10 — stage the PINNED Claude Code CLI into the packaged app.
//
// electron-builder ships `staging/claude/` as `extraResources` → `<resources>/claude/`.
// The desktop main process points PC_BUNDLED_CLAUDE_EXE at the binary inside it,
// and the runtime resolver runs it by default (below an explicit override /
// claudeExe setting / CLAUDE_EXE, above PATH) — so the app is locked to a known
// CLI version regardless of what `claude` the user has installed globally.
//
// MUST run AFTER `stage-resources.mjs` (that script `rm -rf`s the whole staging
// dir on entry). Wired into `prepackage` after `pnpm stage`.
//
// Source: PC_CLAUDE_SRC env, else the native installer's default
// `~/.local/bin/claude(.exe)`. The pinned version is asserted against
// PC_CLAUDE_PIN (default below) so a wrong-version binary can't silently ship;
// set PC_CLAUDE_SKIP_VERSION_CHECK=1 only for deliberate local experiments.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// The version the app's boot/queue/JSONL/system-prompt parsers are verified
// against. Bump deliberately + re-verify; do not float. ONE source of truth is
// preflight.ts PINNED_CLAUDE_VERSION — keep this, that, and the onboarding
// wizard in lockstep (they drifted 160/160/163 before 0.2.0).
// 2.1.165 (2026-06-05): a full day of live dev-stack verification on this
// version (dispatch/ask-resume/workflow/replay/resume) — Emerson's call.
const PINNED_VERSION = process.env.PC_CLAUDE_PIN ?? '2.1.165';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
const OUT_DIR = resolve(__dirname, '..', 'staging', 'claude');
const DEST = join(OUT_DIR, binaryName);

const src = process.env.PC_CLAUDE_SRC
  ? resolve(process.env.PC_CLAUDE_SRC)
  : join(homedir(), '.local', 'bin', binaryName);

if (!existsSync(src)) {
  console.error(
    `[stage-claude] pinned Claude CLI not found at ${src}\n` +
      `  Install ${PINNED_VERSION} (https://claude.ai/install) or point PC_CLAUDE_SRC ` +
      `at a ${binaryName} of that version. The packaged app must ship the pinned CLI.`,
  );
  process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(src, DEST);
if (process.platform !== 'win32') chmodSync(DEST, 0o755);

// Assert the pin. Run the staged copy so we verify exactly what ships.
let reported = 'unknown';
if (process.env.PC_CLAUDE_SKIP_VERSION_CHECK === '1') {
  console.warn('[stage-claude] PC_CLAUDE_SKIP_VERSION_CHECK=1 — skipping version assert');
} else {
  try {
    reported = execFileSync(DEST, ['--version'], { encoding: 'utf-8' }).trim();
  } catch (err) {
    console.error(`[stage-claude] could not run ${DEST} --version: ${err?.message ?? err}`);
    process.exit(1);
  }
  if (!reported.includes(PINNED_VERSION)) {
    console.error(
      `[stage-claude] version mismatch: expected ${PINNED_VERSION}, got "${reported}".\n` +
        `  Refusing to ship an unpinned CLI. Fix the source binary or bump PC_CLAUDE_PIN ` +
        `(and re-verify PC's parsers against the new version first).`,
    );
    process.exit(1);
  }
}

// Provenance marker next to the binary.
writeFileSync(
  join(OUT_DIR, 'VERSION'),
  `${PINNED_VERSION}\nsource: ${src}\nreported: ${reported}\n`,
);

console.log(`staged claude ${PINNED_VERSION} → ${DEST}`);
