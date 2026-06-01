// Slice 011 (11B) — typed localhost client.
//
// A thin wrapper over the existing raw-HTTP `ToolContext` helpers. It does NOT
// re-implement `node:http`; it injects the raw helpers and runs the matching
// `@pc/contracts` DTO guard over the response body. Every method returns BOTH
// the parsed DTO (when the body parses + matches the DTO shape) AND the raw
// `{ status, body }` — so handlers keep emitting the byte-identical raw `body`
// text and only consult `parsed` for internal type-safety. On a non-2xx or a
// parse/shape miss, `parsed.ok` is false but `body`/`status` still carry the
// raw server response (the compat fallback baked in).
//
// The client lives in `packages/mcp` (NOT a shared package): it is
// MCP-process-specific (localhost loopback to PC_SERVER_PORT) and a shared
// package would drag HTTP concerns into a browser-safe boundary.

import {
  isAgentRunDto,
  isAreaDto,
  isAttachmentDto,
  isFieldSchemaDto,
  isPendingAskDto,
  isStageDto,
  isWorkflowDefinitionDto,
  isWorkflowRunDto,
  isWorkItemDto,
  parseErr,
  parseOk,
  type AgentRunDto,
  type AreaDto,
  type AttachmentDto,
  type FieldSchemaDto,
  type ParseResult,
  type PendingAskDto,
  type StageDto,
  type WorkflowDefinitionDto,
  type WorkflowRunDto,
  type WorkItemDto,
} from '@pc/contracts';
import type { ServerResponse, ToolContext } from '../tools/context.ts';

/** The raw-HTTP transport surface the typed client needs from ToolContext.
 *  Injected (not re-implemented) so transport stays in one place. */
export interface TypedClientTransport {
  postServer: (path: string, body: unknown) => Promise<ServerResponse>;
  putServer: (path: string, body: unknown) => Promise<ServerResponse>;
  getServer: (path: string) => Promise<ServerResponse>;
  patchServer: (path: string, body: unknown) => Promise<ServerResponse>;
  deleteServer: (path: string) => Promise<ServerResponse>;
}

/** A typed-client outcome. `status`/`body` are ALWAYS the raw server response
 *  (the compat fallback). `parsed` carries the DTO on a clean 2xx + shape
 *  match, or a typed error otherwise. Handlers emit `body` verbatim. */
export interface TypedResult<T> {
  status: number;
  body: string;
  parsed: ParseResult<T>;
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Parse a raw response into a DTO drawn out of the response envelope.
 *  `extract` pulls the candidate value (e.g. `body.workItem`) from the parsed
 *  JSON object; `guard` validates it. Never throws — a malformed body or a
 *  shape miss surfaces as a typed error while `status`/`body` stay raw. */
function toTyped<T>(
  res: ServerResponse,
  extract: (body: Record<string, unknown>) => unknown,
  guard: (value: unknown) => value is T,
  label: string,
): TypedResult<T> {
  if (!isOkStatus(res.status)) {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label} failed (${res.status})`, 'INTERNAL', { status: res.status }),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label}: malformed JSON body`, 'INTERNAL'),
    };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label}: response body is not an object`, 'INTERNAL'),
    };
  }
  const candidate = extract(json as Record<string, unknown>);
  if (!guard(candidate)) {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label}: response shape did not match the DTO`, 'INTERNAL'),
    };
  }
  return { status: res.status, body: res.body, parsed: parseOk(candidate) };
}

/** Parse a raw response into a homogeneous DTO array. */
function toTypedList<T>(
  res: ServerResponse,
  extract: (body: Record<string, unknown>) => unknown,
  guard: (value: unknown) => value is T,
  label: string,
): TypedResult<T[]> {
  if (!isOkStatus(res.status)) {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label} failed (${res.status})`, 'INTERNAL', { status: res.status }),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label}: malformed JSON body`, 'INTERNAL'),
    };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label}: response body is not an object`, 'INTERNAL'),
    };
  }
  const candidate = extract(json as Record<string, unknown>);
  if (!Array.isArray(candidate) || !candidate.every(guard)) {
    return {
      status: res.status,
      body: res.body,
      parsed: parseErr(`${label}: response list shape did not match the DTO`, 'INTERNAL'),
    };
  }
  return { status: res.status, body: res.body, parsed: parseOk(candidate as T[]) };
}

/**
 * Typed localhost client. Construct from a `ToolContext` (or any compatible
 * transport). Each method shapes the request EXACTLY as the legacy handler
 * does (no wire change), issues it through the injected raw helper, and parses
 * the response through a contract DTO guard. The raw `{ status, body }` is
 * always preserved for byte-identical handler output.
 */
export class TypedLocalhostClient {
  private readonly t: TypedClientTransport;

  constructor(transport: TypedClientTransport) {
    this.t = transport;
  }

  static fromContext(ctx: ToolContext): TypedLocalhostClient {
    return new TypedLocalhostClient({
      postServer: ctx.postServer,
      putServer: ctx.putServer,
      getServer: ctx.getServer,
      patchServer: ctx.patchServer,
      deleteServer: ctx.deleteServer,
    });
  }

  // ── work-item family ──────────────────────────────────────────────────────

  /** POST a work-item create. Body shaped by the caller (frozen wire). */
  async createWorkItem(path: string, payload: unknown): Promise<TypedResult<WorkItemDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(res, (b) => b.workItem, isWorkItemDto, 'createWorkItem');
  }

  async getWorkItem(path: string): Promise<TypedResult<WorkItemDto>> {
    const res = await this.t.getServer(path);
    return toTyped(res, (b) => b.workItem, isWorkItemDto, 'getWorkItem');
  }

  async listWorkItems(path: string): Promise<TypedResult<WorkItemDto[]>> {
    const res = await this.t.getServer(path);
    return toTypedList(res, (b) => b.workItems, isWorkItemDto, 'listWorkItems');
  }

  /** POST a work-item move (frozen wire body). */
  async moveWorkItem(path: string, payload: unknown): Promise<TypedResult<WorkItemDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(res, (b) => b.workItem, isWorkItemDto, 'moveWorkItem');
  }

  /** POST a work-item update (frozen wire body). */
  async updateWorkItem(path: string, payload: unknown): Promise<TypedResult<WorkItemDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(res, (b) => b.workItem, isWorkItemDto, 'updateWorkItem');
  }

  async listAreas(path: string): Promise<TypedResult<AreaDto[]>> {
    const res = await this.t.getServer(path);
    return toTypedList(res, (b) => b.areas, isAreaDto, 'listAreas');
  }

  /** POST an attachment (frozen wire body). */
  async attachToWorkItem(path: string, payload: unknown): Promise<TypedResult<AttachmentDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(res, (b) => b.attachment, isAttachmentDto, 'attachToWorkItem');
  }

  // ── project-config family ───────────────────────────────────────────────

  async listFieldSchemas(path: string): Promise<TypedResult<FieldSchemaDto[]>> {
    const res = await this.t.getServer(path);
    return toTypedList(res, (b) => b.schemas, isFieldSchemaDto, 'listFieldSchemas');
  }

  /** Stage list is read off the project document's `stages` array. */
  async listStages(path: string): Promise<TypedResult<StageDto[]>> {
    const res = await this.t.getServer(path);
    return toTypedList(res, (b) => b.stages, isStageDto, 'listStages');
  }

  // ── workflow family ────────────────────────────────────────────────────

  async getWorkflow(path: string): Promise<TypedResult<WorkflowDefinitionDto>> {
    const res = await this.t.getServer(path);
    return toTyped(res, (b) => b.workflow, isWorkflowDefinitionDto, 'getWorkflow');
  }

  async fireWorkflow(path: string, payload: unknown): Promise<TypedResult<WorkflowRunDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(res, (b) => b.run ?? b.workflowRun, isWorkflowRunDto, 'fireWorkflow');
  }

  // ── agent-run / pending family ───────────────────────────────────────────

  async invokeAgent(path: string, payload: unknown): Promise<TypedResult<AgentRunDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(res, (b) => b.run ?? b.agentRun, isAgentRunDto, 'invokeAgent');
  }

  async continueAgent(path: string, payload: unknown): Promise<TypedResult<AgentRunDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(res, (b) => b.run ?? b.agentRun, isAgentRunDto, 'continueAgent');
  }

  async createPendingAsk(path: string, payload: unknown): Promise<TypedResult<PendingAskDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(res, (b) => b.pendingAsk ?? b.ask, isPendingAskDto, 'createPendingAsk');
  }

  async answerPendingAsk(path: string, payload: unknown): Promise<TypedResult<PendingAskDto>> {
    const res = await this.t.postServer(path, payload);
    return toTyped(res, (b) => b.pendingAsk ?? b.ask, isPendingAskDto, 'answerPendingAsk');
  }
}
