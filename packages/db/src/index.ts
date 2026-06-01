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
  softDeleteProject,
  softDeleteProjectInDb,
  updateProjectMeta,
  updateProjectMetaInDb,
  updateProjectStages,
} from './repos/projects.ts';
export type {
  CreateProjectInput,
  ListProjectsOptions,
  UpdateProjectMetaInput,
} from './repos/projects.ts';

export {
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
  applyAgentVerification,
  applyRunOutcome,
  countWorkItemsInStage,
  createWorkItem,
  getWorkItem,
  getWorkItemByCallsign,
  getWorkItemIncludingArchived,
  listArchivedWorkItems,
  listChildWorkItems,
  listEphemeralCompletedOlderThan,
  listWorkItems,
  moveWorkItemStage,
  patchWorkItem,
  reassignStage,
  restoreWorkItem,
  setAssignedAgentRunId,
  softDeleteWorkItem,
  updateWorkItemFields,
  updateWorkItemStatus,
  WorkItemVersionConflictError,
} from './repos/work-items.ts';
export type { CreateWorkItemInput, PatchWorkItemInput } from './repos/work-items.ts';

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
  bumpAgentRev,
  cloneAgentToProject,
  createAgent,
  createKnowledge,
  createMcpServer,
  createSecret,
  deleteKnowledge,
  deleteMcpServer,
  deleteSecret,
  getAgentById,
  getAgentByName,
  getKnowledge,
  getKnowledgeByName,
  getMcpServer,
  getMcpServerByName,
  getPodForSpawn,
  getSecret,
  getSecretByEnvVarName,
  isProjectDispatchable,
  listAgents,
  listProjectVisibleAgents,
  listKnowledge,
  listMcpServers,
  listSecrets,
  promoteAgentToGlobal,
  resolveAgentForDispatch,
  restoreAgent,
  softDeleteAgent,
  updateAgent,
  updateKnowledge,
} from './repos/pods.ts';
export type {
  CloneAgentResult,
  CloneAgentToProjectInput,
  CreateAgentInput,
  CreateKnowledgeInput,
  CreateMcpServerInput,
  CreateSecretInput,
  GetAgentByNameInput,
  GetKnowledgeByNameInput,
  GetMcpServerByNameInput,
  GetSecretByEnvInput,
  ListAgentsOptions,
  ListKnowledgeOptions,
  ListMcpServersOptions,
  ListSecretsOptions,
  UpdateAgentInput,
  UpdateKnowledgeInput,
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

// Section 25 — agent inbox / delivery repo.
export {
  enqueueInboxRow,
  getAuditForInbox,
  getInboxRow,
  listPendingForSession,
  markInboxDelivered,
} from './repos/agent-inbox.ts';
export type {
  EnqueueInboxRowInput,
  MarkInboxDeliveredInput,
} from './repos/agent-inbox.ts';

// Section 25 — pending asks repo.
export {
  createPendingAsk,
  getPendingAsk,
  hasOpenPendingAskForRun,
  listOpenPendingAsksForProject,
  listOpenPendingAsksForSession,
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
  findActiveContinuation,
  getAgentRunRow,
  insertAgentRunRow,
  listActiveAgentRunsForProject,
  listAgentRunsForSession,
  listAndReconcileOrphanedRuns,
  listNonTerminalAgentRuns,
  markAgentRunTerminal,
  reconcileOrphanedRunningRuns,
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

// Slice 007 — mailbox + pending-interaction repos (additive; alongside Channel).
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
  listRecipientsForInbox,
  listRecipientsForMessage,
  markDeliveryAccepted,
  markDeliveryDeadLettered,
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

export {
  answerPendingInteraction,
  cancelPendingInteraction,
  createPendingInteraction,
  expireOpenPendingInteractions,
  expirePendingInteraction,
  findOpenPendingInteractionBySource,
  getPendingInteraction,
  listOpenPendingInteractions,
  listPendingInteractionsForProject,
} from './repos/pending-interactions.ts';
export type {
  AnswerPendingInteractionInput,
  CreatePendingInteractionInput,
  PendingInteractionRow,
} from './repos/pending-interactions.ts';
