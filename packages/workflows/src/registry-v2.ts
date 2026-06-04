// Section 19 — v2 workflow registry. Scans `.project-companion/workflows/` for
// `version: 2` YAML files, parses + validates each (parseWorkflowV2Text), and
// indexes valid/invalid for the UI. Coexists with the v1 WorkflowRegistry until
// the 19.13 cutover: each registry skips the other's files (v2 by the
// `version: 2` marker, v1 by its absence).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { WorkflowV2 } from '@pc/domain';
import { parseWorkflowV2Text } from './serialize-v2.ts';

export interface ValidWorkflowV2Entry {
  filePath: string;
  fileName: string;
  workflow: WorkflowV2.Workflow;
  yamlText: string;
}

export interface InvalidWorkflowV2Entry {
  filePath: string;
  fileName: string;
  errors: string[];
}

export interface RegistryV2State {
  valid: ValidWorkflowV2Entry[];
  invalid: InvalidWorkflowV2Entry[];
}

export class WorkflowV2Registry {
  private state: RegistryV2State = { valid: [], invalid: [] };

  constructor(private readonly workflowsDir: string) {}

  /** Re-scan the workflows dir. Cheap — a small set of YAML files. v1 files
   *  (no `version: 2`) are skipped silently. */
  reload(): RegistryV2State {
    if (!existsSync(this.workflowsDir)) {
      this.state = { valid: [], invalid: [] };
      return this.state;
    }

    const next: RegistryV2State = { valid: [], invalid: [] };
    const files = readdirSync(this.workflowsDir).filter(
      (f) => extname(f) === '.yaml' || extname(f) === '.yml'
    );

    for (const fileName of files) {
      const filePath = join(this.workflowsDir, fileName);
      const expectedId = basename(fileName, extname(fileName));

      let yamlText = '';
      try {
        yamlText = readFileSync(filePath, 'utf-8');
      } catch (err) {
        next.invalid.push({ filePath, fileName, errors: [`read failed: ${(err as Error).message}`] });
        continue;
      }

      const result = parseWorkflowV2Text(yamlText, { expectedId });
      if (result.ok) {
        next.valid.push({ filePath, fileName, workflow: result.workflow, yamlText });
      } else if (result.notV2) {
        continue; // a v1 file — the v1 registry owns it
      } else {
        next.invalid.push({ filePath, fileName, errors: result.errors });
      }
    }

    this.state = next;
    return this.state;
  }

  /** Last-known state without re-scanning. */
  snapshot(): RegistryV2State {
    return this.state;
  }

  /** All valid v2 workflows. Reloads so live edits surface. */
  listValid(): WorkflowV2.Workflow[] {
    this.reload();
    return this.state.valid.map((e) => e.workflow);
  }

  /** Look up a valid v2 workflow by id. Reloads first. */
  findById(id: string): ValidWorkflowV2Entry | undefined {
    this.reload();
    return this.state.valid.find((e) => e.workflow.id === id);
  }
}
