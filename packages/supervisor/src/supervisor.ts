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

  /**
   * Graceful stop with a deadline: signal everyone, wait, then SIGKILL any
   * child still running. A graceful stop that can't complete escalates — it
   * never hangs (the host shutdown-never-exits lesson). Returns true if every
   * child exited gracefully.
   */
  async stopAndWait(signal: NodeJS.Signals = 'SIGINT', timeoutMs = 4_000): Promise<boolean> {
    this.stopAll(signal);
    const results = await Promise.all(this.children.map((c) => c.waitForExit(timeoutMs)));
    let allGraceful = true;
    results.forEach((exited, i) => {
      if (exited) return;
      allGraceful = false;
      const child = this.children[i];
      this.log(`[supervisor] ${child.name} missed the ${timeoutMs}ms stop deadline — SIGKILL`);
      child.killHard();
    });
    return allGraceful;
  }

  get isStopping(): boolean {
    return this.signalled;
  }
}
