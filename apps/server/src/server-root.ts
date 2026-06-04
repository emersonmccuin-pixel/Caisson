// THE one derivation of the trunk root. Everything resource-relative (templates,
// public, drizzle, mcp bundle) hangs off this.
//
// MUST live directly in `src/` — the dev/test runtime executes this file at
// `apps/server/src/` while the bundled runtime executes `apps/server/dist/server.mjs`,
// and only at this depth do both resolve three hops up to the same trunk root.
// (Step-3 incident: a second copy in `services/` used four hops — right from src,
// one level too high from the bundle — so every dev agent dispatch failed with
// "pod materialisation failed ... scandir <trunk-parent>\templates\.claude\hooks".)
//
// Packaged Electron sets PC_ROOT (the unpacked resources dir) and it wins outright.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export const SERVER_ROOT = process.env.PC_ROOT
  ? resolve(process.env.PC_ROOT)
  : resolve(HERE, '..', '..', '..');
