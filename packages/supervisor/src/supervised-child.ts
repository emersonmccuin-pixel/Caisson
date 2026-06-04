// One supervised child process: spawn → watch → respawn-with-backoff.
//
// This is THE respawn engine for the whole app (dev === packaged). The logic is
// ported faithfully from the proven apps/server/scripts/dev-supervisor.mjs:
// sentinel restart sequence, rapid-crash budget with healthy-uptime reset,
// give-up after N rapid crashes. Node-builtins only — this module must never
// pull node-pty (or anything heavy) into the Electron main bundle.

import { spawn as nodeSpawn, type ChildProcess, type StdioOptions } from 'node:child_process';

export interface ChildSpec {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  shell?: boolean;
}

export interface RestartPolicy {
  /** Base backoff in ms; doubles per consecutive attempt. */
  backoffBaseMs: number;
  /** Backoff ceiling in ms. */
  backoffMaxMs: number;
  /** A run that stayed up at least this long resets the rapid-crash budget. */
  healthyUptimeMs: number;
  /** More than this many consecutive rapid crashes → give up (stop respawning). */
  maxCrashRestarts: number;
  /**
   * Exiting with THIS code is an intentional restart, not a crash: it uses its
   * own backoff sequence, never counts toward the crash budget, and never gives
   * up. `null` = no sentinel (every exit is judged by the crash rules).
   */
  sentinelRestartCode: number | null;
  /** A sentinel restart after at least this long resets the sentinel backoff. */
  sentinelHealthyUptimeMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  backoffBaseMs: 500,
  backoffMaxMs: 8_000,
  healthyUptimeMs: 30_000,
  maxCrashRestarts: 3,
  sentinelRestartCode: null,
  sentinelHealthyUptimeMs: 5_000,
};

export interface SupervisedChildDeps {
  spawn?: typeof nodeSpawn;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface ExitInfo {
  name: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  uptimeMs: number;
}

export interface SupervisedChildHooks {
  /** Runs before every (re)spawn — e.g. wait for ports to free. */
  preSpawn?: () => Promise<void>;
  /**
   * Runs after a spawn — e.g. wait for a lock file to publish. Returning false
   * is logged but does NOT kill the child; readiness enforcement (if any) is the
   * caller's decision, matching dev-supervisor's "start anyway" behavior.
   */
  onReady?: (child: ChildProcess) => Promise<boolean | void> | boolean | void;
  /** Pipe child stdout/stderr somewhere. */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
  /** Crash budget exhausted — the supervisor decides the app-level response. */
  onGiveUp?: (info: ExitInfo) => void;
  /** Fired on every spawn (bookkeeping / tests). */
  onSpawn?: (child: ChildProcess) => void;
}

export class SupervisedChild {
  readonly name: string;

  private readonly spec: ChildSpec;
  private readonly policy: RestartPolicy;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly hooks: SupervisedChildHooks;

  private child: ChildProcess | null = null;
  private stopping = false;
  private gaveUp = false;
  private startedAt = 0;
  private crashCount = 0;
  private sentinelAttempt = 0;

  constructor(args: {
    spec: ChildSpec;
    policy?: Partial<RestartPolicy>;
    deps?: SupervisedChildDeps;
    hooks?: SupervisedChildHooks;
  }) {
    this.spec = args.spec;
    this.name = args.spec.name;
    this.policy = { ...DEFAULT_RESTART_POLICY, ...args.policy };
    const deps = args.deps ?? {};
    this.spawnImpl = deps.spawn ?? nodeSpawn;
    this.now = deps.now ?? Date.now;
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = deps.log ?? (() => {});
    this.hooks = args.hooks ?? {};
  }

  get current(): ChildProcess | null {
    return this.child;
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  get hasGivenUp(): boolean {
    return this.gaveUp;
  }

  /** Spawn and keep alive until stop(). No-op if already running or stopped. */
  async start(): Promise<void> {
    if (this.stopping || this.child) return;
    await this.spawnOnce();
  }

  /** Graceful stop: suppress respawn and signal the child. */
  stop(signal: NodeJS.Signals = 'SIGINT'): void {
    this.stopping = true;
    if (this.child) this.child.kill(signal);
  }

  /** Resolve true once the current child has exited (immediately if none).
   *  False = still running at the deadline (caller escalates, e.g. SIGKILL). */
  waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (!child) return Promise.resolve(true);
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once('exit', onExit);
    });
  }

  /** Last resort after a graceful stop misses its deadline. */
  killHard(): void {
    this.stopping = true;
    if (this.child) this.child.kill('SIGKILL');
  }

  private async spawnOnce(): Promise<void> {
    if (this.stopping) return;
    if (this.hooks.preSpawn) await this.hooks.preSpawn();
    if (this.stopping) return;

    this.startedAt = this.now();
    const child = this.spawnImpl(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: this.spec.stdio ?? ['ignore', 'pipe', 'pipe'],
      shell: this.spec.shell ?? false,
    });
    this.child = child;
    this.hooks.onSpawn?.(child);

    if (this.hooks.onOutput) {
      child.stdout?.on('data', (b: Buffer) => this.hooks.onOutput?.('stdout', b));
      child.stderr?.on('data', (b: Buffer) => this.hooks.onOutput?.('stderr', b));
    }
    child.on('error', (err) => this.log(`[${this.name}] child error: ${err.message}`));
    child.once('exit', (code, signal) => this.onExit(code, signal));

    if (this.hooks.onReady) {
      const ready = await this.hooks.onReady(child);
      if (ready === false) {
        this.log(`[${this.name}] readiness gate not satisfied — continuing`);
      }
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    const uptimeMs = this.now() - this.startedAt;

    if (this.stopping) {
      this.log(`[${this.name}] stopped (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
      return;
    }

    // Intentional restart (sentinel) — its own backoff, never a crash.
    if (this.policy.sentinelRestartCode !== null && code === this.policy.sentinelRestartCode) {
      if (uptimeMs >= this.policy.sentinelHealthyUptimeMs) this.sentinelAttempt = 0;
      const delayMs = Math.min(
        this.policy.backoffBaseMs * 2 ** this.sentinelAttempt,
        this.policy.backoffMaxMs,
      );
      this.sentinelAttempt += 1;
      this.log(`[${this.name}] intentional restart (exit ${code}) — respawning in ${delayMs}ms`);
      this.scheduleRespawn(delayMs);
      return;
    }

    // Crash. A healthy run resets the rapid-crash budget so a transient crash
    // recovers, but a boot-time crash-loop accumulates toward the cap.
    if (uptimeMs >= this.policy.healthyUptimeMs) this.crashCount = 0;
    this.crashCount += 1;
    if (this.crashCount > this.policy.maxCrashRestarts) {
      this.gaveUp = true;
      this.log(
        `[${this.name}] crashed (code=${code ?? 'null'} signal=${signal ?? 'none'}) after ${uptimeMs}ms — ${this.policy.maxCrashRestarts} rapid crashes, giving up`,
      );
      this.hooks.onGiveUp?.({ name: this.name, code, signal, uptimeMs });
      return;
    }
    const delayMs = Math.min(
      this.policy.backoffBaseMs * 2 ** (this.crashCount - 1),
      this.policy.backoffMaxMs,
    );
    this.log(
      `[${this.name}] crashed (code=${code ?? 'null'} signal=${signal ?? 'none'}) after ${uptimeMs}ms — auto-respawning in ${delayMs}ms (recovery ${this.crashCount}/${this.policy.maxCrashRestarts})`,
    );
    this.scheduleRespawn(delayMs);
  }

  private scheduleRespawn(delayMs: number): void {
    void this.delay(delayMs).then(() => {
      if (this.stopping) return;
      void this.spawnOnce();
    });
  }
}
