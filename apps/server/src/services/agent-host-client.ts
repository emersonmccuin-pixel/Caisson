import { EventEmitter } from 'node:events';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type {
  AgentHostCommand,
  AgentHostCommandResponse,
  AgentHostEndpoint,
  AgentHostEvent,
  AgentHostIdentity,
  AgentHostRunSnapshot,
} from '@pc/runtime';
import {
  discoverAgentHostEndpoint,
} from '@pc/runtime';
import { getDataDir } from '@pc/utils';

import type { AgentHostReattachClient } from './agent-host-reattach.ts';

type WireId = string | number;

export interface JsonLineAgentHostTransport {
  /** Host stdout, read by the API. */
  input: Readable;
  /** Host stdin, written by the API. */
  output: Writable;
}

export interface JsonLineAgentHostClientOptions {
  requestTimeoutMs?: number;
  idPrefix?: string;
  onProtocolError?: (error: Error) => void;
}

export interface HttpAgentHostClientOptions {
  requestTimeoutMs?: number;
  onProtocolError?: (error: Error) => void;
  fetch?: FetchLike;
}

export interface ResolveAgentHostClientForBootOptions
  extends Pick<HttpAgentHostClientOptions, 'requestTimeoutMs' | 'onProtocolError' | 'fetch'> {
  dataDir?: string;
  isPidAlive?: (pid: number) => boolean;
  discoverEndpoint?: () => AgentHostEndpoint | null;
  connect?: (
    endpoint: AgentHostEndpoint,
  ) => AgentHostReattachClient | Promise<AgentHostReattachClient>;
  onConnectionError?: (error: Error, endpoint: AgentHostEndpoint) => void;
}

interface PendingRequest {
  command: AgentHostCommand['type'];
  resolve: (response: AgentHostCommandResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface WireResponse {
  type: 'response';
  id?: WireId;
  response?: unknown;
  ok?: boolean;
  error?: unknown;
}

interface WireEvent {
  type: 'event';
  event?: unknown;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class JsonLineAgentHostClient
  extends EventEmitter
  implements AgentHostReattachClient
{
  private readonly lineReader: Interface;
  private readonly requestTimeoutMs: number;
  private readonly idPrefix: string;
  private readonly onProtocolError?: (error: Error) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly runs = new Map<string, AgentHostRunSnapshot>();
  private nextId = 0;
  private lastSeq = 0;
  private closed = false;

  constructor(
    private readonly transport: JsonLineAgentHostTransport,
    options: JsonLineAgentHostClientOptions = {},
  ) {
    super();
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idPrefix = options.idPrefix ?? 'api';
    this.onProtocolError = options.onProtocolError;
    this.lineReader = createInterface({
      input: transport.input,
      crlfDelay: Infinity,
    });
    this.lineReader.on('line', (line) => this.handleLine(line));
    this.lineReader.on('close', () => {
      this.closePending(new Error('agent host stream closed'));
    });
    transport.input.on('error', (err) => {
      this.closePending(toError(err));
    });
    transport.output.on('error', (err) => {
      this.closePending(toError(err));
    });
  }

  async hello(apiPid = process.pid): Promise<AgentHostIdentity> {
    const response = await this.sendCommand({
      type: 'hello',
      apiPid,
      protocolVersion: 1,
    });
    if (!response.ok || response.command !== 'hello') {
      throw new Error(commandErrorMessage(response, 'hello'));
    }
    return response.identity;
  }

  async refreshRuns(): Promise<readonly AgentHostRunSnapshot[]> {
    const response = await this.sendCommand({ type: 'list-runs' });
    if (!response.ok || response.command !== 'list-runs') {
      throw new Error(commandErrorMessage(response, 'list-runs'));
    }
    this.setRuns(response.runs);
    return this.listRuns();
  }

  listRuns(): readonly AgentHostRunSnapshot[] {
    return Array.from(this.runs.values());
  }

  sendCommand(command: AgentHostCommand): Promise<AgentHostCommandResponse> {
    if (this.closed) {
      return Promise.reject(new Error('agent host client is closed'));
    }

    const id = `${this.idPrefix}-${++this.nextId}`;
    const payload = JSON.stringify({ id, command });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `agent host command ${command.type} timed out after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        command: command.type,
        resolve,
        reject,
        timeout,
      });

      this.transport.output.write(`${payload}\n`, (err) => {
        if (!err) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(toError(err));
      });
    });
  }

  onEvent(listener: (event: AgentHostEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lineReader.close();
    this.closePending(new Error('agent host client closed'));
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let wire: unknown;
    try {
      wire = JSON.parse(trimmed);
    } catch (err) {
      this.reportProtocolError(toError(err));
      return;
    }

    if (isWireEvent(wire)) {
      if (!isAgentHostEvent(wire.event)) {
        this.reportProtocolError(new Error('agent host emitted malformed event'));
        return;
      }
      this.applyEvent(wire.event);
      this.emit('event', wire.event);
      return;
    }

    if (isWireResponse(wire)) {
      this.applyWireResponse(wire);
      return;
    }

    this.reportProtocolError(new Error('agent host emitted malformed wire message'));
  }

  private applyWireResponse(wire: WireResponse): void {
    const id = normalizeWireId(wire.id);
    if (!id) {
      this.reportProtocolError(new Error('agent host response omitted id'));
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      this.reportProtocolError(
        new Error(`agent host response referenced unknown id ${id}`),
      );
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timeout);

    if (!isAgentHostCommandResponse(wire.response)) {
      pending.reject(
        new Error(
          typeof wire.error === 'string'
            ? wire.error
            : 'agent host response was malformed',
        ),
      );
      return;
    }

    if (wire.response.command !== pending.command) {
      pending.reject(
        new Error(
          `agent host response command mismatch: expected ${pending.command}, got ${wire.response.command}`,
        ),
      );
      return;
    }

    this.applyResponse(wire.response);
    pending.resolve(wire.response);
  }

  private applyResponse(response: AgentHostCommandResponse): void {
    this.lastSeq = Math.max(this.lastSeq, response.lastSeq);
    if (!response.ok) return;
    if (response.command === 'list-runs') {
      this.setRuns(response.runs);
      return;
    }
    if ('run' in response) {
      this.runs.set(response.run.runId, response.run);
    }
  }

  private applyEvent(event: AgentHostEvent): void {
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    if (event.type === 'run-state' || event.type === 'run-terminal') {
      this.runs.set(event.run.runId, event.run);
    }
  }

  private setRuns(runs: readonly AgentHostRunSnapshot[]): void {
    this.runs.clear();
    for (const run of runs) {
      this.runs.set(run.runId, run);
    }
  }

  private closePending(error: Error): void {
    this.closed = true;
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
  }

  private reportProtocolError(error: Error): void {
    this.onProtocolError?.(error);
    this.emit('protocol-error', error);
  }
}

export class HttpAgentHostClient
  extends EventEmitter
  implements AgentHostReattachClient
{
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly onProtocolError?: (error: Error) => void;
  private readonly fetchImpl: FetchLike;
  private readonly runs = new Map<string, AgentHostRunSnapshot>();
  private eventAbort: AbortController | null = null;
  private lastSeq = 0;
  private closed = false;

  constructor(
    endpoint: AgentHostEndpoint | string,
    options: HttpAgentHostClientOptions = {},
  ) {
    super();
    this.baseUrl = normalizeBaseUrl(
      typeof endpoint === 'string' ? endpoint : endpoint.baseUrl,
    );
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onProtocolError = options.onProtocolError;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async hello(apiPid = process.pid): Promise<AgentHostIdentity> {
    const response = await this.sendCommand({
      type: 'hello',
      apiPid,
      protocolVersion: 1,
    });
    if (!response.ok || response.command !== 'hello') {
      throw new Error(commandErrorMessage(response, 'hello'));
    }
    return response.identity;
  }

  async refreshRuns(): Promise<readonly AgentHostRunSnapshot[]> {
    const response = await this.sendCommand({ type: 'list-runs' });
    if (!response.ok || response.command !== 'list-runs') {
      throw new Error(commandErrorMessage(response, 'list-runs'));
    }
    this.setRuns(response.runs);
    return this.listRuns();
  }

  listRuns(): readonly AgentHostRunSnapshot[] {
    return Array.from(this.runs.values());
  }

  async sendCommand(command: AgentHostCommand): Promise<AgentHostCommandResponse> {
    if (this.closed) {
      throw new Error('agent host client is closed');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url('/command'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
        signal: controller.signal,
      });
    } catch (err) {
      throw fetchCommandError(command.type, err, this.requestTimeoutMs);
    } finally {
      clearTimeout(timeout);
    }

    const body = await parseJsonResponse(response);
    if (!isAgentHostCommandResponse(body)) {
      throw new Error(`agent host command ${command.type} returned malformed response`);
    }
    if (body.command !== command.type) {
      throw new Error(
        `agent host response command mismatch: expected ${command.type}, got ${body.command}`,
      );
    }

    this.applyResponse(body);
    return body;
  }

  onEvent(listener: (event: AgentHostEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  startEventStream(): void {
    if (this.closed || this.eventAbort) return;
    const controller = new AbortController();
    this.eventAbort = controller;
    void this.readEventStream(controller.signal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.eventAbort?.abort();
    this.eventAbort = null;
    this.removeAllListeners();
  }

  private async readEventStream(signal: AbortSignal): Promise<void> {
    try {
      const response = await this.fetchImpl(
        this.url(`/events?after=${encodeURIComponent(String(this.lastSeq))}`),
        { signal },
      );
      if (!response.ok || !response.body) {
        throw new Error(`agent host event stream failed with HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.drainEventBuffer(buffer);
      }
      buffer += decoder.decode();
      this.drainEventBuffer(buffer);
    } catch (err) {
      if (!this.closed && !signal.aborted) this.reportProtocolError(toError(err));
    } finally {
      if (this.eventAbort?.signal === signal) this.eventAbort = null;
    }
  }

  private drainEventBuffer(buffer: string): string {
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) return buffer;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) this.handleEventLine(line);
    }
  }

  private handleEventLine(line: string): void {
    let wire: unknown;
    try {
      wire = JSON.parse(line);
    } catch (err) {
      this.reportProtocolError(toError(err));
      return;
    }

    if (!isWireEvent(wire) || !isAgentHostEvent(wire.event)) {
      this.reportProtocolError(new Error('agent host emitted malformed event'));
      return;
    }
    this.applyEvent(wire.event);
    this.emit('event', wire.event);
  }

  private applyResponse(response: AgentHostCommandResponse): void {
    this.lastSeq = Math.max(this.lastSeq, response.lastSeq);
    if (!response.ok) return;
    if (response.command === 'list-runs') {
      this.setRuns(response.runs);
      return;
    }
    if ('run' in response) {
      this.runs.set(response.run.runId, response.run);
    }
  }

  private applyEvent(event: AgentHostEvent): void {
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    if (event.type === 'run-state' || event.type === 'run-terminal') {
      this.runs.set(event.run.runId, event.run);
    }
  }

  private setRuns(runs: readonly AgentHostRunSnapshot[]): void {
    this.runs.clear();
    for (const run of runs) {
      this.runs.set(run.runId, run);
    }
  }

  private reportProtocolError(error: Error): void {
    this.onProtocolError?.(error);
    this.emit('protocol-error', error);
  }

  private url(path: string): string {
    return new URL(path, this.baseUrl).href;
  }
}

export async function connectJsonLineAgentHostClientForBoot(
  transport: JsonLineAgentHostTransport,
  options: JsonLineAgentHostClientOptions = {},
): Promise<JsonLineAgentHostClient> {
  const client = new JsonLineAgentHostClient(transport, options);
  await client.hello();
  await client.refreshRuns();
  return client;
}

export async function connectHttpAgentHostClientForBoot(
  endpoint: AgentHostEndpoint,
  options: HttpAgentHostClientOptions = {},
): Promise<HttpAgentHostClient> {
  const client = new HttpAgentHostClient(endpoint, options);
  await client.hello();
  await client.refreshRuns();
  client.startEventStream();
  return client;
}

export function resolveAgentHostClientForBoot(
  options: ResolveAgentHostClientForBootOptions = {},
):
  | AgentHostReattachClient
  | Promise<AgentHostReattachClient | null>
  | null {
  const endpoint =
    options.discoverEndpoint !== undefined
      ? options.discoverEndpoint()
      : discoverAgentHostEndpoint({
          dataDir: options.dataDir ?? getDataDir(),
          ...(options.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
        });
  if (!endpoint) return null;

  const connect =
    options.connect ??
    ((hostEndpoint: AgentHostEndpoint) =>
      connectHttpAgentHostClientForBoot(hostEndpoint, {
        requestTimeoutMs: options.requestTimeoutMs,
        onProtocolError: options.onProtocolError,
        fetch: options.fetch,
      }));

  return Promise.resolve(connect(endpoint)).catch((err) => {
    options.onConnectionError?.(toError(err), endpoint);
    return null;
  });
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new Error(
      `agent host returned non-JSON HTTP ${response.status}: ${toError(err).message}`,
    );
  }
  if (!response.ok) {
    throw new Error(`agent host returned HTTP ${response.status}`);
  }
  return body;
}

function fetchCommandError(
  command: AgentHostCommand['type'],
  err: unknown,
  timeoutMs: number,
): Error {
  const error = toError(err);
  if (error.name === 'AbortError') {
    return new Error(`agent host command ${command} timed out after ${timeoutMs}ms`);
  }
  return error;
}

function isWireEvent(value: unknown): value is WireEvent {
  return isObject(value) && value.type === 'event';
}

function isWireResponse(value: unknown): value is WireResponse {
  return isObject(value) && value.type === 'response';
}

function isAgentHostEvent(value: unknown): value is AgentHostEvent {
  return (
    isObject(value) &&
    typeof value.seq === 'number' &&
    typeof value.type === 'string'
  );
}

function isAgentHostCommandResponse(
  value: unknown,
): value is AgentHostCommandResponse {
  if (
    !isObject(value) ||
    typeof value.ok !== 'boolean' ||
    typeof value.command !== 'string' ||
    typeof value.lastSeq !== 'number'
  ) {
    return false;
  }

  if (!value.ok) {
    return typeof value.code === 'string' && typeof value.error === 'string';
  }

  switch (value.command) {
    case 'hello':
      return isAgentHostIdentity(value.identity);
    case 'list-runs':
      return Array.isArray(value.runs) && value.runs.every(isAgentHostRunSnapshot);
    case 'start-run':
    case 'resume-run':
    case 'send':
    case 'mark-paused':
    case 'answer-pending':
    case 'cancel':
      return isAgentHostRunSnapshot(value.run);
    case 'notify-mcp-handshake':
    case 'shutdown':
      return true;
    default:
      return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isAgentHostIdentity(value: unknown): value is AgentHostIdentity {
  return (
    isObject(value) &&
    typeof value.hostId === 'string' &&
    typeof value.pid === 'number' &&
    typeof value.startedAt === 'number' &&
    value.protocolVersion === 1
  );
}

function isAgentHostRunSnapshot(value: unknown): value is AgentHostRunSnapshot {
  return (
    isObject(value) &&
    typeof value.runId === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.dispatcherSessionId === 'string' &&
    typeof value.ccSessionId === 'string' &&
    typeof value.podName === 'string' &&
    typeof value.worktreeDir === 'string' &&
    typeof value.state === 'string' &&
    (typeof value.jsonlPath === 'string' || value.jsonlPath === null) &&
    (typeof value.transcriptPath === 'string' || value.transcriptPath === null) &&
    typeof value.queuedAt === 'number' &&
    (typeof value.spawnedAt === 'number' || value.spawnedAt === null) &&
    (typeof value.readyAt === 'number' || value.readyAt === null) &&
    typeof value.updatedAt === 'number' &&
    (typeof value.terminalAt === 'number' || value.terminalAt === null)
  );
}

function normalizeWireId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function commandErrorMessage(
  response: AgentHostCommandResponse,
  expected: AgentHostCommand['type'],
): string {
  if (!response.ok) {
    return `agent host command ${expected} failed: ${response.error}`;
  }
  return `agent host command ${expected} returned ${response.command}`;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
