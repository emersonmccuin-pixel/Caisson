// PC-owned Claude runtime bundle.
//
// Claude Code auto-discovers `.mcp.json` and `.claude/*` from the current
// working directory. PC spawns Claude in the user's project cwd, but its
// runtime control plane must not live there: terminal-launched Claude sessions
// in the same repo would inherit it. This module renders the PC-owned MCP,
// settings, hooks, and env fragments into per-session data dirs instead.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProjectById } from '@pc/db';
import type { PodMcpServerConfig, ULID } from '@pc/domain';
import { resolveNodeLauncher } from '@pc/runtime';
import { getDataDir } from '@pc/utils';

import { applyNodeLauncher } from './mcp-config-rewrite.ts';
import { renderTemplate } from './project-scaffold.ts';

const DEFAULT_SERVER_PORT = 4040;
const DEFAULT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');

export interface ClaudeRuntimeFilesInput {
  /** Per-session or per-run scratch dir. Runtime files land under here. */
  scratchDir: string;
  /** User project/worktree cwd for the Claude process. */
  worktreeDir: string;
  projectId?: ULID | null;
  projectSlug?: string | null;
  projectName?: string | null;
  dataDir?: string;
  templatesDir?: string;
  trunkPath?: string;
  serverPort?: number;
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
    },
  };
}

function renderPcMcpBaseline(ctx: RuntimeContext): Record<string, PodMcpServerConfig> {
  const config: { mcpServers: Record<string, PodMcpServerConfig> } = {
    mcpServers: {
      'pc-rig': {
        command: 'node',
        args: [posixPath(resolve(ctx.trunkPath, 'packages', 'mcp', 'dist', 'server.mjs'))],
        env: {
          PC_PROJECT_ID: ctx.projectId,
          PC_PROJECT_SLUG: ctx.projectSlug,
          PC_SERVER_PORT: String(ctx.serverPort),
        },
      },
      // ☠ FD-3: the `webhook` channel-server entry is gone — the mailbox is
      // the one notify door; no per-session channel child is spawned.
    },
  };
  applyNodeLauncher(config, resolveNodeLauncher());
  return config.mcpServers;
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
  return process.env.PC_ROOT ? resolve(process.env.PC_ROOT) : DEFAULT_ROOT;
}

function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
