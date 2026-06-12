export { getDb, getRawDb, closeDb } from './connection.ts';
export type { DB, DbExecutor, DbTransaction } from './connection.ts';
export { newId } from './id.ts';
export { runMigrations, assertSchemaIntact } from './migrate.ts';

export {
  createProject,
  createProjectInDb,
  getProjectById,
  getProjectByIdInDb,
  getProjectBySlug,
  getProjectBySlugInDb,
  listProjects,
  listProjectsInDb,
  reorderProjects,
  reorderProjectsInDb,
  setProjectFocus,
  setProjectFocusInDb,
  softDeleteProject,
  softDeleteProjectInDb,
  updateProjectMeta,
  updateProjectMetaInDb,
  updateProjectNotes,
  updateProjectNotesInDb,
  updateProjectStages,
} from './repos/projects.ts';
export type {
  CreateProjectInput,
  ListProjectsOptions,
  UpdateProjectMetaInput,
} from './repos/projects.ts';

export {
  getLatestLiveEventForEntity,
  getLiveEventFloor,
  getLiveEventHighWater,
  insertLiveEvent,
  listLiveEventsAfter,
  listLiveOutboxRowsAfter,
  markLiveEventsPublished,
  pruneLiveOutbox,
  LiveEventCursorError,
} from './repos/live-outbox.ts';
export type {
  InsertLiveEventDraft,
  ListLiveEventsAfterInput,
  ListLiveEventsAfterResult,
  LiveOutboxEvent,
  LiveOutboxScope,
  PruneLiveOutboxInput,
  PruneLiveOutboxResult,
} from './repos/live-outbox.ts';

export {
  appendWorkItemHistory,
  applyRunOutcome,
  countWorkItemsInStage,
  createWorkItem,
  getWorkItem,
  getWorkItemByCallsign,
  getWorkItemByCallsignGlobal,
  getWorkItemIncludingArchived,
  listArchivedWorkItems,
  listChildWorkItems,
  listFocusedWorkItems,
  listWorkItems,
  moveWorkItemStage,
  patchWorkItem,
  reassignStage,
  restoreWorkItem,
  searchWorkItems,
  setWorkItemFocus,
  softDeleteWorkItem,
  toSlimWorkItem,
  updateWorkItemFields,
  updateWorkItemStatus,
  WorkItemVersionConflictError,
} from './repos/work-items.ts';
export type {
  CreateWorkItemInput,
  ListWorkItemsOptions,
  PatchWorkItemInput,
  SearchWorkItemsInput,
  WorkItemAreaFilter,
  WorkItemSearchResult,
  WorkItemSlim,
} from './repos/work-items.ts';

// Slice 013 — agent_contracts repo (persistence-only; app-services announces).
export {
  createContract,
  createContractInDb,
  getContract,
  getContractInDb,
  listContractsForProject,
  listContractsForProjectInDb,
  listContractsForRun,
  listContractsForRunInDb,
  listContractsForWorkItem,
  listContractsForWorkItemInDb,
  listContractsPendingLanding,
  setContractDeliverable,
  setContractLanding,
  setContractRun,
  setContractVerification,
} from './repos/contracts.ts';
export type {
  ContractRow,
  CreateContractInput,
  SetDeliverableInput,
  SetLandingInput,
  SetVerificationInput,
} from './repos/contracts.ts';

// Slice 010 — Areas repo (persistence-only; app-services announces).
export {
  createArea,
  createAreaInDb,
  getArea,
  getAreaInDb,
  listAreas,
  listAreasInDb,
  patchArea,
  patchAreaInDb,
  reorderAreas,
  reorderAreasInDb,
  setWorkItemArea,
  setWorkItemAreaInDb,
  softDeleteArea,
  softDeleteAreaInDb,
} from './repos/areas.ts';
export type {
  AreaRow,
  CreateAreaInput,
  ListAreasOptions,
  PatchAreaInput,
} from './repos/areas.ts';

export {
  createAttachment,
  deleteAttachment,
  getAttachment,
  listAttachmentsForWorkItem,
} from './repos/attachments.ts';
export type { CreateAttachmentInput } from './repos/attachments.ts';

export { listFieldSchemas, replaceFieldSchemas } from './repos/field-schemas.ts';
export type { ReplaceFieldSchemasInput } from './repos/field-schemas.ts';

// Section 19 — v2 run sidecar + event-log repo. v1 workflow-runs repo
// dropped in 19.12 (migration 0025 dropped the underlying table).
// Access as workflowRunsV2Repo.createRun(...), .appendEvent(...), etc.
export * as workflowRunsV2Repo from './repos/workflow-runs-v2.ts';
export type { WorkflowRunV2Record } from './repos/workflow-runs-v2.ts';

// Section 19.16 — promoted workflows table + audit log. Access as
// workflowsRepo.createWorkflow(...), .listWorkflows(...), etc.
export * as workflowsRepo from './repos/workflows.ts';
export { buildWorkflowAuditRow, listWorkflowAudit } from './repos/workflow-audit.ts';
export type {
  BuildWorkflowAuditRowInput,
  ListWorkflowAuditOptions,
  WorkflowAuditInput,
  WorkflowAuditRowValues,
} from './repos/workflow-audit.ts';

export {
  getActiveWorktreeByName,
  listActiveWorktrees,
  markWorktreeDestroyed,
  upsertWorktree,
} from './repos/worktrees.ts';
export type { UpsertWorktreeInput } from './repos/worktrees.ts';

export { getGlobalSettings, setGlobalSettings } from './repos/settings.ts';

export {
  addAgentToProject,
  bumpAgentRev,
  createAgent,
  createSecret,
  deleteSecret,
  getAgentById,
  getAgentByName,
  getPodForSpawn,
  getSecret,
  getSecretByEnvVarName,
  listAgentProjects,
  listAgents,
  listProjectMemberAgents,
  listProjectVisibleAgents,
  listSecrets,
  removeAgentFromProject,
  resolveAgentForDispatch,
  restoreAgent,
  setAgentShareable,
  softDeleteAgent,
  toAgentContextDoc,
  updateAgent,
} from './repos/pods.ts';
export type {
  CreateAgentInput,
  CreateSecretInput,
  GetAgentByNameInput,
  GetSecretByEnvInput,
  ListAgentsOptions,
  ListSecretsOptions,
  UpdateAgentInput,
} from './repos/pods.ts';
export { buildAuditRow, listAgentAudit } from './repos/pod-audit.ts';
export type {
  AuditInput,
  AuditRowValues,
  BuildAuditRowInput,
  ListAgentAuditOptions,
} from './repos/pod-audit.ts';

export {
  dismissFailedRun,
  listFailedRunDismissalsForProject,
  listFailedRunDismissalsForRuns,
} from './repos/failed-run-dismissals.ts';

// Section 31.12 — post-turn summary log repo.
export {
  insertPostTurnSummary,
  listPostTurnSummariesForProject,
  listPostTurnSummariesForSession,
} from './repos/post-turn-summaries.ts';
export type {
  InsertPostTurnSummaryInput,
  PostTurnSummaryRow,
} from './repos/post-turn-summaries.ts';

// Section 31.11 — statusline snapshot log repo.
export {
  getLatestSnapshotForProject,
  insertStatuslineSnapshot,
  listLatestSnapshotPerSession,
  listSnapshotsForProjectSince,
  listSnapshotsForSession,
} from './repos/statusline-snapshots.ts';
export type {
  InsertStatuslineSnapshotInput,
  StatuslineSnapshotRow,
} from './repos/statusline-snapshots.ts';

// ☠ M4a (2026-06-04) — the agent-inbox repo is DELETED with its tables
// (migration 0041 archive-rename; FD-12 bypass #3 executed). The mailbox is
// the one delivery system.

// Section 25 — pending asks repo.
// M3b — conversation replay store (chat events in SQLite; replay = a query).
export {
  appendConversationEvent,
  appendConversationEvents,
  countConversationEvents,
  getConversationHighWaterSeq,
  getConversationReplayState,
  hasConversationEvents,
  listConversationEvents,
} from './repos/conversation-events.ts';
export type {
  AppendConversationEventInput,
  ConversationEventRow,
} from './repos/conversation-events.ts';

export {
  createPendingAsk,
  getPendingAsk,
  hasOpenPendingAskForRun,
  hasPendingAskForRun,
  listOpenPendingAsksForProject,
  listOpenPendingAsksForSession,
  listOpenPendingAsksOlderThan,
  markPendingAskAnswered,
  markPendingAskCancelled,
} from './repos/pending-asks.ts';
export type {
  AnswerPendingAskInput,
  CreatePendingAskInput,
} from './repos/pending-asks.ts';

// Section 25 — pod-revision helper for drift detection.
export {
  computePodRevision,
  podRevisionsDiffer,
} from './repos/pod-revision.ts';
export type { ComputePodRevisionInput } from './repos/pod-revision.ts';

// Section 25 — agent runs repo.
export {
  bumpAgentRunRev,
  findActiveContinuation,
  getAgentRunRow,
  insertAgentRunRow,
  listActiveAgentRunsForProject,
  listAgentRunsForSession,
  listNonTerminalAgentRuns,
  listRecentTerminalAgentRuns,
  markAgentRunDelivered,
  markAgentRunTerminal,
  setAgentRunContractId,
  touchAgentRunActivity,
  updateAgentRunPid,
  updateAgentRunStatus,
} from './repos/agent-runs.ts';
export type {
  InsertAgentRunRowInput,
  ListAgentRunsForSessionOptions,
  MarkAgentRunTerminalInput,
  UpdateAgentRunStatusInput,
} from './repos/agent-runs.ts';

export {
  createOrchestratorSession,
  endOrchestratorSession,
  getActiveOrchestratorSession,
  getOrchestratorSession,
  listOrchestratorSessionsForProject,
  reactivateOrchestratorSession,
  setOrchestratorSessionJsonlCursor,
  setOrchestratorSessionJsonlPath,
  setOrchestratorSessionTitle,
} from './repos/orchestrator-sessions.ts';
export type { CreateOrchestratorSessionInput } from './repos/orchestrator-sessions.ts';

// Slice 1 (Areas + context model) — ContextDoc repo.
export {
  createContextDoc,
  createContextDocInDb,
  getContextDoc,
  getContextDocInDb,
  listContextChainDocs,
  listContextChainDocsInDb,
  getAgentContextDocByTitle,
  listContextDocsForScope,
  listContextDocsForScopeInDb,
  sanitizeFts5Query,
  searchContextDocs,
  softDeleteContextDoc,
  softDeleteContextDocInDb,
  updateContextDoc,
  updateContextDocInDb,
} from './repos/context-docs.ts';
export type {
  ContextDocRow,
  ContextDocScope,
  ContextDocSearchResult,
  ContextDocWithRank,
  CreateContextDocInput,
  ListContextChainDocsInput,
  ListContextDocsOptions,
  UpdateContextDocInput,
} from './repos/context-docs.ts';

// Migration 0056 — context-doc read receipts (staleness/usage tracking).
export {
  getContextDocReadStats,
  listContextDocReadsForRun,
  recordContextDocReads,
} from './repos/context-doc-reads.ts';
export type {
  ContextDocReadStats,
  ContextDocReadVia,
  ContextDocSessionKind,
  RecordContextDocReadsInput,
} from './repos/context-doc-reads.ts';

export {
  cancelOpenOrchestratorSendsForSession,
  cancelQueuedOrchestratorSend,
  enqueueOrchestratorSend,
  getOrchestratorSendByClientMessageId,
  getOrchestratorSendQueueRow,
  hasOpenOrchestratorSendsForSession,
  listOpenOrchestratorSendsForSession,
  listQueuedOrchestratorSendsForSession,
  listVisibleOrchestratorSendsForSession,
  markOrchestratorSendDelivered,
  markOrchestratorSendDelivering,
  markOrchestratorSendFailed,
  markNextDeliveredOrchestratorSendObservedInJsonl,
  recordDeliveredOrchestratorSend,
  retryFailedOrchestratorSend,
} from './repos/orchestrator-send-queue.ts';
export type {
  EnqueueOrchestratorSendInput,
  OrchestratorSendQueueRow,
  OrchestratorSendQueueStatus,
  RecordDeliveredOrchestratorSendInput,
} from './repos/orchestrator-send-queue.ts';

// Connector-auth Slice 1 (pc-pty-chat-400.2) — Credentials vault repo.
// Connector-auth Slice 3 (pc-pty-chat-400.4) — added getCredentialByServerAndKind.
export {
  createCredential,
  deleteCredential,
  getCredential,
  getCredentialByServer,
  getCredentialByServerAndKind,
  listCredentialsByScope,
  updateCredentialAuthState,
} from './repos/credentials.ts';
export type { CreateCredentialInput } from './repos/credentials.ts';

// pc-pty-chat-359 P1/P2 — MCP Server Registry repo.
export {
  createMcpServerRegistry,
  getMcpServerRegistry,
  listMcpServersRegistry,
  patchMcpServerRegistry,
  replaceTransportOnly,
  setMcpServerDiscovery,
  softDeleteMcpServerRegistry,
} from './repos/mcp-servers.ts';
export type {
  CreateMcpServerRegistryInput,
  ListMcpServersRegistryOptions,
  PatchMcpServerRegistryInput,
  SetMcpServerDiscoveryInput,
} from './repos/mcp-servers.ts';

// pc-pty-chat-359 P3 — Agent MCP Attachments repo.
export {
  deleteMcpAttachmentByPair,
  getMcpAttachment,
  getMcpAttachmentByPair,
  listMcpAttachmentsForAgent,
  upsertMcpAttachment,
} from './repos/mcp-attachments.ts';
export type { UpsertMcpAttachmentInput } from './repos/mcp-attachments.ts';

// Slice 007 — mailbox repos. (☠ M8/FD-7: pending-interaction repo — the
// write-only AskShadow side-table; archived in migration 0045.)
export {
  acquireDeliveryLease,
  enqueueMailboxMessage,
  getMailboxDelivery,
  getMailboxMessage,
  getMailboxMessageByIdempotencyKey,
  getMailboxRecipient,
  listAuditForMessage,
  listDeadLettersForMessage,
  listDeliveriesForMessage,
  listDeliveriesForProject,
  listDueDeliveries,
  listMailboxMessagesBySource,
  listRecipientsForInbox,
  listRecipientsForMessage,
  listUserInboxRecipientsAllProjects,
  markDeliveryAccepted,
  markDeliveryDeadLettered,
  markDeliveryDeferred,
  markDeliveryRetrying,
  markRecipientActioned,
  markRecipientDismissed,
  markRecipientRead,
  writeAudit,
} from './repos/mailbox.ts';
export type {
  EnqueueMailboxMessageInput,
  EnqueueMailboxMessageResult,
  EnqueueMailboxRecipientRow,
  MailboxAuditRow,
  MailboxDeadLetterRow,
  MailboxDeliveryRow,
  MailboxMessageRow,
  MailboxRecipientRow,
  WriteAuditInput,
} from './repos/mailbox.ts';
