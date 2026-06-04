// AgentRunRegistry — global concurrency cap + FIFO over-cap queue.
//
// Design §4.1: dispatched AgentRuns share a single global cap (default 5,
// clamped 1..50; validated by labs scenario 03 — N=5 reliable, N=8 introduces
// handshake-timeout rate). Persistent-interactive runs (the orchestrator
// chat) take the cap-exempt lane via exempt() — admitted instantly, never
// counted.
//
// Contract: callers obtain a Ticket via admit(). The ticket's `granted`
// promise resolves when a slot is available. Calling release() returns the
// slot. Calling abort() removes a still-queued ticket from the FIFO without
// consuming a slot; on an admitted ticket it's equivalent to release().
//
// One Registry instance per Node process is the production shape; tests
// construct fresh instances with whatever cap they need.

import { clampMaxConcurrent } from '@pc/domain';

export type TicketState = 'queued' | 'admitted' | 'released' | 'aborted';

export interface AdmissionTicket {
  /** Resolves when the slot is granted. Rejects with an Error('aborted')
   *  if abort() is called before admission. */
  readonly granted: Promise<void>;
  /** Current ticket state. Transitions monotonically: queued → admitted →
   *  released, OR queued → aborted, OR admitted → aborted (treated as
   *  release at the registry level). */
  readonly state: TicketState;
  /** Free the slot. Idempotent. */
  release(): void;
  /** Remove from queue if still queued; otherwise behaves as release(). */
  abort(): void;
}

export interface AgentRunRegistryOptions {
  /** Default 5. Clamped to [1, 50]. */
  maxConcurrent?: number;
}

export class AgentRunRegistry {
  private active = 0;
  private waiters: TicketImpl[] = [];
  private cap: number;

  constructor(opts: AgentRunRegistryOptions = {}) {
    this.cap = clampMaxConcurrent(opts.maxConcurrent ?? 5);
  }

  /** FD-15 — live-update the cap (settings push; no host restart). Raising it
   *  admits queued waiters immediately. Lowering it never touches admitted
   *  runs — the over-cap drains as they release (same semantics as reattach). */
  setMaxConcurrent(maxConcurrent: number): number {
    this.cap = clampMaxConcurrent(maxConcurrent);
    this.dequeueNext();
    return this.cap;
  }

  admit(): AdmissionTicket {
    const ticket = new TicketImpl(this);
    if (this.active < this.cap) {
      this.active++;
      ticket.markAdmitted();
    } else {
      this.waiters.push(ticket);
    }
    return ticket;
  }

  /** Admit a run that was ALREADY running before this process started — i.e. a
   *  host-reattached run after a server restart. Bypasses the FIFO + cap: the
   *  PTY never left the host, so it isn't subject to admission control; we only
   *  account for its slot so the live count + dequeue math stay correct. This
   *  can push `active` transiently over `cap`; the over-cap drains as
   *  reattached runs reach terminal and release. */
  reattach(): AdmissionTicket {
    const ticket = new TicketImpl(this);
    this.active++;
    ticket.markAdmitted();
    return ticket;
  }

  /** Step-4 G4 — cap-exempt lane for `persistent-interactive` runs (the
   *  orchestrator chat). Admitted immediately, NEVER counts toward `active`,
   *  never queues, and release/abort never touch the slot math — the chat
   *  must not consume an agent slot or wait behind dispatched workers. */
  exempt(): AdmissionTicket {
    return new ExemptTicket();
  }

  getMaxConcurrent(): number {
    return this.cap;
  }

  getActiveCount(): number {
    return this.active;
  }

  getQueueLength(): number {
    return this.waiters.length;
  }

  /** Internal — called by a ticket on release() or abort()-while-admitted. */
  _releaseSlot(): void {
    if (this.active <= 0) return; // defensive; shouldn't happen
    this.active--;
    this.dequeueNext();
  }

  /** Internal — called by a ticket on abort()-while-queued. */
  _withdraw(ticket: TicketImpl): void {
    const idx = this.waiters.indexOf(ticket);
    if (idx >= 0) this.waiters.splice(idx, 1);
  }

  private dequeueNext(): void {
    while (this.active < this.cap && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      // Skip already-aborted waiters (defensive — abort should have called
      // _withdraw, but belt-and-braces).
      if (next.state !== 'queued') continue;
      this.active++;
      next.markAdmitted();
    }
  }
}

/** Cap-exempt ticket — born admitted, holds no slot, releases nothing. */
class ExemptTicket implements AdmissionTicket {
  state: TicketState = 'admitted';
  readonly granted: Promise<void> = Promise.resolve();

  release(): void {
    if (this.state === 'admitted') this.state = 'released';
  }

  abort(): void {
    this.release();
  }
}

class TicketImpl implements AdmissionTicket {
  state: TicketState = 'queued';
  readonly granted: Promise<void>;
  private resolve!: () => void;
  private reject!: (err: Error) => void;

  constructor(private readonly registry: AgentRunRegistry) {
    this.granted = new Promise<void>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    // Avoid unhandled-rejection warnings if no caller awaits granted before
    // abort() fires. Tests and callers that need to observe rejection wire
    // their own .catch / await as usual.
    this.granted.catch(() => {});
  }

  markAdmitted(): void {
    if (this.state !== 'queued') return;
    this.state = 'admitted';
    this.resolve();
  }

  release(): void {
    if (this.state === 'admitted') {
      this.state = 'released';
      this.registry._releaseSlot();
      return;
    }
    if (this.state === 'queued') {
      // Releasing a queued ticket is unusual but harmless — treat as abort
      // without ever consuming a slot.
      this.abort();
    }
    // released / aborted → idempotent no-op.
  }

  abort(): void {
    if (this.state === 'queued') {
      this.state = 'aborted';
      this.registry._withdraw(this);
      this.reject(new Error('aborted'));
      return;
    }
    if (this.state === 'admitted') {
      this.state = 'released';
      this.registry._releaseSlot();
      return;
    }
    // released / aborted → idempotent no-op.
  }
}
