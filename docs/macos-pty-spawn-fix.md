# macOS fix — orchestrator chat fails instantly ("agent host reported the chat run failed")

On macOS, every orchestrator chat / agent run could die within ~1 second with:

> **agent host reported the chat run failed**

…and a **0-byte transcript**. The chat never reached the composer; no Claude
output was ever produced. This document records the root cause and the fix so
the next person on a Mac doesn't have to re-debug it.

## Symptoms

- New orchestrator session → `health: failed_resume`, `ptyState: failed`,
  `spawnAttempt: 1`, almost immediately.
- `data/projects/<id>/sessions/<sid>/transcript.log` is present but **empty**.
- The raw Claude JSONL (`~/.claude/projects/.../<uuid>.jsonl`) **never gets
  created** — Claude never actually started.
- The error message is just the generic fallback; the real cause was swallowed.

## Root cause #1 — `node-pty` `spawn-helper` lost its execute bit

The agent host launches `claude` through a PTY using `node-pty`. On unix,
`node-pty` runs a small prebuilt binary, `spawn-helper`, via `posix_spawnp`.

pnpm's content-addressable install can extract that prebuilt binary **without
the execute bit** (`-rw-r--r--` instead of `-rwxr-xr-x`). When `node-pty` then
tries to exec it, the native layer throws the opaque:

```
Error: posix_spawnp failed.
    at new UnixTerminal (.../node-pty/lib/unixTerminal.js:92:24)
```

Because this throws *before* Claude is launched, the run terminates instantly
with no output — surfacing as "agent host reported the chat run failed" with an
empty transcript.

You can confirm it directly:

```bash
find node_modules -name spawn-helper -exec ls -la {} \;
# darwin-arm64/spawn-helper showing -rw-r--r-- (no `x`) == broken
```

### Fix (durable)

- `scripts/fix-node-pty-perms.mjs` walks `node_modules` and restores `+x` on
  every `spawn-helper` it finds. Idempotent and best-effort.
- It runs automatically as the root **`postinstall`** hook in `package.json`,
  so a future `pnpm install` can never silently re-break it.

To apply it manually right now:

```bash
node scripts/fix-node-pty-perms.mjs
```

## Root cause #2 — the Bypass Permissions acceptance dialog blocked readiness

Once spawning worked, Claude (launched with `--dangerously-skip-permissions`)
stopped at the **one-time interactive acceptance screen**:

```
WARNING: Claude Code running in Bypass Permissions mode
  ❯ 1. No, exit
    2. Yes, I accept
```

It waits there for a keypress and never reaches the composer, so the runtime's
ReadyGate times out.

### Fix

The dialog is **not** gated by `permissions.defaultMode`. In Claude Code's
source the gate is a separate top-level setting, `skipDangerousModePermissionPrompt`
(checked by `hasSkipDangerousModePermissionPrompt()`); setting `defaultMode`
alone does nothing for the dialog. Claude honors the flag from any trusted
source — including the file we pass via `--settings` (`flagSettings`) — but
deliberately ignores a repo's own `.claude/settings.json` for this.

`templates/.claude/settings.template.json` now sets it at the top level:

```json
{
  "skipDangerousModePermissionPrompt": true,
  "permissions": {
    "defaultMode": "bypassPermissions",
    ...
  }
}
```

This:

1. skips the acceptance dialog entirely, and
2. makes Claude print `⏵⏵ bypass permissions on` in its status line — which is
   exactly the init-complete signal the ReadyGate already matches
   (`/bypass permissions on/i`).

> History: an earlier fix set only `defaultMode: bypassPermissions`, which did
> NOT suppress the dialog — the real gate is `skipDangerousModePermissionPrompt`.
> (You could also accept it once by hand in a terminal `claude` session, but the
> template flag means you never have to.)

## Verification

After both fixes, a fresh orchestrator session reaches **ready in ~2s** and a
live prompt round-trips cleanly:

```
state: busy  →  <assistant reply>  →  state: ready
```

…and the raw Claude JSONL transcript is created and persisted.

## TL;DR

| Cause | Fix |
| --- | --- |
| `node-pty/spawn-helper` not executable after pnpm install → `posix_spawnp failed` | `scripts/fix-node-pty-perms.mjs` + root `postinstall` |
| Interactive "Bypass Permissions" dialog blocks ReadyGate | `skipDangerousModePermissionPrompt: true` (top level) in the session settings template — `defaultMode` does NOT gate the dialog |
