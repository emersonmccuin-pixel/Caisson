// Project scaffold writer. Renders trunk-side templates into a project folder
// with per-project tokens substituted. P8's create-project flow calls into
// this after `git init` to produce the durable PC scaffold:
//
//   <folder>/.project-companion/workflows/*.yaml (plain copy)
//   <folder>/README.md                           (rendered)
//
// `setup-wizard-prompt.md` left the scaffold with FD-21 (the wizard modal is
// deleted; the orchestrator interviews + writes CLAUDE.md in the one chat).
//
// The orchestrator's identity used to land here as
// `.project-companion/orchestrator-prompt.md` (rendered + appended at spawn
// via `--append-system-prompt-file`). Section 16a moved it into the
// `agents` DB table (pod-resident); the scaffold no longer writes a per-
// project file. See `apps/server/src/services/orchestrator-pod-content.ts`.
//
// Agents and Claude runtime config are DB/session-resident. The scaffold
// writes no `.mcp.json` or `.claude/*` files; pods materialize at spawn time
// into PC-owned session data via the pod-spawn pipeline.
//
// Template format: `{{TOKEN}}` placeholders, alnum + underscore. Unknown tokens
// pass through so a malformed template is visible on inspection rather than
// silently emptied.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface ProjectScaffoldDeps {
  /** Absolute trunk root (`<pc-repo>/`). Substituted into `{{PC_TRUNK_PATH}}`. */
  trunkPath: string;
  /** Absolute path to the `templates/` dir. */
  templatesDir: string;
  /** Trunk data dir. PROJECT_DATA_DIR is `<dataDir>/projects/<projectId>/`. */
  dataDir: string;
  /** apps/server bind port. Substituted into `{{PC_SERVER_PORT}}`. */
  serverPort: number;
}

export interface ProjectScaffoldTarget {
  /** Absolute path of the user's project folder. */
  folderPath: string;
  /** ULID. */
  projectId: string;
  /** URL-safe slug. */
  projectSlug: string;
  /** Display name. */
  projectName: string;
}

export class ProjectScaffold {
  constructor(private readonly deps: ProjectScaffoldDeps) {}

  /** Full scaffold pass: workflow seeds + README. */
  writeAll(target: ProjectScaffoldTarget): void {
    this.writeProjectCompanionFiles(target);
    this.writeReadme(target);
  }

  /** Like writeAll but skips README.md — used by attach-to-git so the user's
   *  existing project README isn't clobbered. */
  writeWithoutReadme(target: ProjectScaffoldTarget): void {
    this.writeProjectCompanionFiles(target);
  }

  /** Project-visible PC files that should be part of the scaffold commit. */
  writeProjectCompanionFiles(target: ProjectScaffoldTarget): void {
    this.writeWorkflowSeeds(target);
  }

  /** Copy seed workflow YAMLs verbatim (no token substitution). */
  writeWorkflowSeeds(target: ProjectScaffoldTarget): void {
    const srcDir = resolve(this.deps.templatesDir, '.project-companion', 'workflows');
    const destDir = resolve(target.folderPath, '.project-companion', 'workflows');
    if (!existsSync(srcDir)) return;
    mkdirSync(destDir, { recursive: true });
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith('.yaml')) continue;
      copyFileSync(resolve(srcDir, f), resolve(destDir, f));
    }
  }

  /** Render `<folder>/README.md` from template. */
  writeReadme(target: ProjectScaffoldTarget): void {
    this.writeFromTemplate(
      resolve(this.deps.templatesDir, 'README.template.md'),
      resolve(target.folderPath, 'README.md'),
      this.buildTokens(target),
    );
  }

  /** Build the token map for `target`. Exposed for callers that need to render
   *  an ad-hoc template using the same set.
   *
   *  Path tokens are normalized to forward slashes so callers can safely reuse
   *  the same values in JSON templates rendered outside the project root.
   *  Node + git accept forward slashes natively on Windows, so this
   *  normalization is cross-platform safe. */
  buildTokens(target: ProjectScaffoldTarget): Record<string, string> {
    return {
      PC_TRUNK_PATH: posixPath(this.deps.trunkPath),
      PC_SERVER_PORT: String(this.deps.serverPort),
      // Global PC db path. (Historically the ☠ inbox-drain hook's read target —
      // M4a deleted it; the token stays for any future hook needing the db.)
      PC_DB_PATH: posixPath(resolve(this.deps.dataDir, 'pc.sqlite')),
      PROJECT_ID: target.projectId,
      PROJECT_SLUG: target.projectSlug,
      PROJECT_FOLDER: posixPath(target.folderPath),
      PROJECT_NAME: target.projectName,
      PROJECT_DATA_DIR: posixPath(resolve(this.deps.dataDir, 'projects', target.projectId)),
    };
  }

  private writeFromTemplate(
    templatePath: string,
    destPath: string,
    tokens: Record<string, string>,
  ): void {
    const raw = readFileSync(templatePath, 'utf-8');
    const rendered = renderTemplate(raw, tokens);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, rendered, 'utf-8');
  }
}

/** Replace `{{KEY}}` occurrences with `tokens[KEY]`. Unknown keys pass through. */
export function renderTemplate(text: string, tokens: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key]! : m;
  });
}

/** Normalize a Windows path to forward slashes so it's safe to embed in a JSON
 *  string literal without escaping. POSIX paths pass through untouched. */
function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
