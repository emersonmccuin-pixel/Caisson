// PC-owned Claude runtime bundle.
//
// Claude Code auto-discovers `.mcp.json` and `.claude/*` from the current
// working directory. PC spawns Claude in the user's project cwd, but its
// runtime control plane must not live there: terminal-launched Claude sessions
// in the same repo would inherit it. This module renders the PC-owned MCP,
// settings, hooks, and env fragments into per-session data dirs instead.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getProjectById } from '@pc/db';
import type { PodMcpServerConfig, ULID } from '@pc/domain';
import {
  PC_MCP_CLAIM_HEADERS,
  PC_MCP_TOKEN_HEADER,
  type PcMcpClaims,
} from '@pc/mcp/http-endpoint';
import { getDataDir } from '@pc/utils';

import { SERVER_ROOT } from '../server-root.ts';
import { mcpAuthSecret, signMcpClaims } from './mcp-http-auth.ts';
import { renderTemplate } from './project-scaffold.ts';

const DEFAULT_SERVER_PORT = 4040;

/** FD-2 — per-spawn identity baked into the pc-rig HTTP entry's headers.
 *  Mirrors the env-var set the stdio child used to read (PC_SESSION_ID,
 *  PC_AGENT_SESSION_ID, PC_AGENT_RUN_ID, …). Omit a field where the old env
 *  was absent for that spawn kind — behavior parity, not new policy. */
export interface ClaudeRuntimeIdentity {
  /** Orchestrator session ULID / transient `ad-*`/`wb-*`/`sw-*` id. */
  sessionId?: string;
  /** CC session uuid — drives the MCP-handshake ReadyGate signal. */
  agentSessionId?: string;
  agentRunId?: string;
  dispatcherSessionId?: string;
  parentWorkItemId?: string;
  invokeDepth?: number;
}

export interface ClaudeRuntimeFilesInput {
  /** Per-session or per-run scratch dir. Runtime files land under here. */
  scratchDir: string;
  /** User project/worktree cwd for the Claude process. */
  worktreeDir: string;
  projectId?: ULID | null;
  projectSlug?: string | null;
  projectName?: string | null;
  identity?: ClaudeRuntimeIdentity;
  dataDir?: string;
  templatesDir?: string;
  trunkPath?: string;
  serverPort?: number;
  /** Orchestrator-only: write `remoteControlAtStartup: true` into the rendered
   *  settings.json so the session launches remote-ready. Default false — agent
   *  worker sessions are never remote-controlled. */
  remoteControl?: boolean;
}

export interface ClaudeRuntimeFiles {
  /** Session-local settings JSON passed via `--settings`. */
  settingsPath: string;
  /** Baseline-only MCP config for non-pod sessions. Pod sessions write their
   *  own merged MCP config separately. */
  mcpConfigPath: string;
  /** Empty string disables user/project/local settings discovery. */
  settingSources: '';
  /** PC-owned baseline MCP servers merged with pod-declared MCP rows. */
  baselineMcpServers: Record<string, PodMcpServerConfig>;
  /** Spawn env needed by hooks/MCP routing. */
  extraEnv: Record<string, string>;
  cleanup(): void;
}

export function prepareClaudeRuntimeFiles(input: ClaudeRuntimeFilesInput): ClaudeRuntimeFiles {
  const ctx = resolveRuntimeContext(input);
  const runtimeRoot = resolve(input.scratchDir, 'claude-runtime');
  const hookDestDir = resolve(runtimeRoot, '.claude', 'hooks');
  const hookSrcDir = resolve(ctx.templatesDir, '.claude', 'hooks');
  const settingsSrc = resolve(ctx.templatesDir, '.claude', 'settings.template.json');
  const settingsPath = resolve(runtimeRoot, '.claude', 'settings.json');
  const mcpConfigPath = resolve(runtimeRoot, 'mcp.json');

  mkdirSync(hookDestDir, { recursive: true });
  for (const f of readdirSync(hookSrcDir)) {
    if (!f.endsWith('.cjs')) continue;
    const raw = readFileSync(resolve(hookSrcDir, f), 'utf8');
    writeFileSync(resolve(hookDestDir, f), renderTemplate(raw, ctx.hookTokens), 'utf8');
  }

  const settingsRaw = readFileSync(settingsSrc, 'utf8');
  writeFileSync(settingsPath, renderTemplate(settingsRaw, ctx.settingsTokens), 'utf8');
  const baselineMcpServers = renderPcMcpBaseline(ctx);
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: baselineMcpServers }, null, 2) + '\n', 'utf8');

  return {
    settingsPath,
    mcpConfigPath,
    settingSources: '',
    baselineMcpServers,
    extraEnv: runtimeEnv(ctx),
    cleanup() {
      try {
        rmSync(runtimeRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

interface RuntimeContext {
  projectId: string;
  projectSlug: string;
  projectName: string;
  worktreeDir: string;
  identity: ClaudeRuntimeIdentity;
  dataDir: string;
  templatesDir: string;
  trunkPath: string;
  serverPort: number;
  hookTokens: Record<string, string>;
  settingsTokens: Record<string, string>;
}

function resolveRuntimeContext(input: ClaudeRuntimeFilesInput): RuntimeContext {
  const project = input.projectId ? getProjectById(input.projectId) : null;
  const projectId = input.projectId ?? project?.id ?? '';
  const projectSlug = input.projectSlug ?? project?.slug ?? '';
  const projectName = input.projectName ?? project?.name ?? '';
  const worktreeDir = input.worktreeDir;
  const dataDir = input.dataDir ?? getDataDir();
  const templatesDir = input.templatesDir ?? resolve(rootPath(input.trunkPath), 'templates');
  const trunkPath = rootPath(input.trunkPath);
  const serverPort = input.serverPort ?? Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
  const runtimeRoot = resolve(input.scratchDir, 'claude-runtime');
  const baseTokens = {
    PC_TRUNK_PATH: posixPath(trunkPath),
    PC_SERVER_PORT: String(serverPort),
    PC_DB_PATH: posixPath(resolve(dataDir, 'pc.sqlite')),
    PROJECT_ID: projectId,
    PROJECT_SLUG: projectSlug,
    PROJECT_NAME: projectName,
    PROJECT_DATA_DIR: posixPath(resolve(dataDir, 'projects', projectId || 'unknown')),
  };

  return {
    projectId,
    projectSlug,
    projectName,
    worktreeDir,
    identity: input.identity ?? {},
    dataDir,
    templatesDir,
    trunkPath,
    serverPort,
    hookTokens: {
      ...baseTokens,
      PROJECT_FOLDER: posixPath(worktreeDir),
    },
    settingsTokens: {
      ...baseTokens,
      // The settings template uses PROJECT_FOLDER to point at hook scripts.
      // For PC-spawned sessions those scripts live in the session bundle, not
      // the user's repo.
      PROJECT_FOLDER: posixPath(runtimeRoot),
      // Rendered as a bare JSON boolean — orchestrator sessions pass true to
      // launch remote-ready; agent workers leave it false.
      REMOTE_CONTROL_AT_STARTUP: input.remoteControl ? 'true' : 'false',
    },
  };
}

function renderPcMcpBaseline(ctx: RuntimeContext): Record<string, PodMcpServerConfig> {
  // ☠ FD-2 (Step-4 Slice 0): the per-session stdio pc-rig child is DEAD — every
  // PC-spawned session calls the ONE shared HTTP tools endpoint in the API
  // server. Identity = claim headers + an HMAC token the server signed at spawn
  // time (mcp-http-auth); the endpoint re-verifies on every request.
  // ☠ FD-3: the `webhook` channel-server entry is gone — the mailbox is the one
  // notify door; no per-session channel child is spawned.
  const claims: PcMcpClaims = {
    projectId: ctx.projectId,
    sessionId: ctx.identity.sessionId ?? '',
    agentSessionId: ctx.identity.agentSessionId ?? '',
    agentRunId: ctx.identity.agentRunId ?? '',
    dispatcherSessionId: ctx.identity.dispatcherSessionId ?? '',
    parentWorkItemId: ctx.identity.parentWorkItemId ?? '',
    invokeDepth: ctx.identity.invokeDepth ?? 0,
  };
  const token = signMcpClaims(mcpAuthSecret(ctx.dataDir), claims);
  return {
    'pc-rig': {
      type: 'http',
      url: `http://127.0.0.1:${ctx.serverPort}/api/mcp`,
      headers: {
        [PC_MCP_CLAIM_HEADERS.projectId]: claims.projectId,
        [PC_MCP_CLAIM_HEADERS.sessionId]: claims.sessionId,
        [PC_MCP_CLAIM_HEADERS.agentSessionId]: claims.agentSessionId,
        [PC_MCP_CLAIM_HEADERS.agentRunId]: claims.agentRunId,
        [PC_MCP_CLAIM_HEADERS.dispatcherSessionId]: claims.dispatcherSessionId,
        [PC_MCP_CLAIM_HEADERS.parentWorkItemId]: claims.parentWorkItemId,
        [PC_MCP_CLAIM_HEADERS.invokeDepth]: String(claims.invokeDepth),
        [PC_MCP_TOKEN_HEADER]: token,
      },
    },
  };
}

function runtimeEnv(ctx: RuntimeContext): Record<string, string> {
  return {
    PC_PROJECT_ID: ctx.projectId,
    PC_PROJECT_SLUG: ctx.projectSlug,
    PC_SERVER_PORT: String(ctx.serverPort),
  };
}

function rootPath(override: string | undefined): string {
  if (override && override.trim()) return resolve(override);
  // Step 3 — was a second import.meta.url hop-count here; wrong from the
  // bundle, so every dev agent dispatch failed pod materialisation.
  return SERVER_ROOT;
}

function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
