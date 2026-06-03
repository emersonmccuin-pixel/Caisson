// The one supervisor: holds a declared list of supervised children, starts them
// in order, and forwards a shutdown signal to all of them. This is the single
// owner of process supervision for the whole app — Electron main runs exactly
// one of these in both dev and packaged. The child LIST is the only thing that
// varies; the supervision behavior is identical everywhere.

import { SupervisedChild } from './supervised-child.ts';

export interface SupervisorDeps {
  log?: (msg: string) => void;
}

export class Supervisor {
  private readonly children: SupervisedChild[];
  private readonly log: (msg: string) => void;
  private signalled = false;

  constructor(args: { children: SupervisedChild[]; deps?: SupervisorDeps }) {
    this.children = args.children;
    this.log = args.deps?.log ?? (() => {});
  }

  get all(): readonly SupervisedChild[] {
    return this.children;
  }

  /**
   * Start every child in declared order, awaiting each one's readiness gate
   * before the next. Declared order is how a dependency (e.g. the agent host's
   * lock file must exist before the API boots) is expressed.
   */
  async start(): Promise<void> {
    for (const child of this.children) {
      await child.start();
    }
  }

  /** Forward a signal to all children and suppress their respawn. Idempotent. */
  stopAll(signal: NodeJS.Signals = 'SIGINT'): void {
    if (this.signalled) return;
    this.signalled = true;
    this.log(`[supervisor] ${signal} — forwarding to ${this.children.length} child(ren)`);
    for (const child of this.children) child.stop(signal);
  }

  get isStopping(): boolean {
    return this.signalled;
  }
}
