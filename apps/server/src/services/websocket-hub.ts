export interface WebSocketLike {
  readonly OPEN: number;
  readyState: number;
  send(data: string): void;
}

/**
 * Per-project WebSocket fanout.
 *
 * This deliberately supports multiple subscribers for one project. Browser
 * reload races, split views, and diagnostics tabs should not detach the
 * surviving client from broadcasts.
 */
export class ProjectWebSocketHub<ProjectId extends string = string> {
  private subscribers = new Map<ProjectId, Set<WebSocketLike>>();

  subscribe(projectId: ProjectId, socket: WebSocketLike): () => void {
    let set = this.subscribers.get(projectId);
    if (!set) {
      set = new Set();
      this.subscribers.set(projectId, set);
    }
    set.add(socket);

    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      const current = this.subscribers.get(projectId);
      if (!current) return;
      current.delete(socket);
      if (current.size === 0 && this.subscribers.get(projectId) === current) {
        this.subscribers.delete(projectId);
      }
    };
  }

  broadcast(projectId: ProjectId, msg: unknown): number {
    const set = this.subscribers.get(projectId);
    if (!set) return 0;
    const tagged =
      msg !== null && typeof msg === 'object'
        ? { projectId, ...(msg as Record<string, unknown>) }
        : msg;
    const data = JSON.stringify(tagged);
    let sent = 0;
    for (const socket of set) {
      // Prune dead subscribers as we go: a closed/closing socket left in the
      // set otherwise lingers until the keepalive sweep, silently absorbing a
      // project's broadcasts. Drop it now so the count reflects real delivery.
      if (socket.readyState !== socket.OPEN) {
        set.delete(socket);
        continue;
      }
      socket.send(data);
      sent++;
    }
    if (set.size === 0) this.subscribers.delete(projectId);
    return sent;
  }

  broadcastAll(msg: unknown): number {
    const data = JSON.stringify(msg);
    let sent = 0;
    for (const projectId of [...this.subscribers.keys()]) {
      const set = this.subscribers.get(projectId);
      if (!set) continue;
      for (const socket of set) {
        // Prune dead subscribers as we go, matching broadcast(): a closed/
        // closing socket otherwise lingers until the keepalive sweep.
        if (socket.readyState !== socket.OPEN) {
          set.delete(socket);
          continue;
        }
        socket.send(data);
        sent++;
      }
      if (set.size === 0) this.subscribers.delete(projectId);
    }
    return sent;
  }

  count(projectId: ProjectId): number {
    return this.subscribers.get(projectId)?.size ?? 0;
  }
}
