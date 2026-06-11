export type { ULID } from './ulid.ts';
export type {
  StatuslineRateLimit,
  StatuslineSnapshot,
} from './statusline.ts';
export type {
  WorkItem,
  WorkItemHistoryEntry,
  WorkItemSlim,
  WorkItemStatus,
  WorkItemType,
} from './work-item.ts';
export { WORK_ITEM_TYPES, isWorkItemType } from './work-item.ts';
// Slice 023 — the v1 `work-item-contract.ts` union is deleted. The contract
// (`contract.ts`, the v2 7-mechanism union) is the single authority. These flat
// re-exports keep the historical import surface (`ExpectedOutput`,
// `AcceptanceCriteria`, …) pointing at the v2 shapes.
export type {
  AcceptanceCriteria,
  AcceptancePredicate,
  AcceptancePredicateKind,
  ExpectedOutput,
  ExpectedOutputKind,
  VerificationStatus,
  VerificationTier,
} from './contract.ts';
export {
  ACCEPTANCE_PREDICATE_KINDS,
  EXPECTED_OUTPUT_KINDS,
  PREDICATE_DECIDABILITY,
  VERIFICATION_STATUSES,
  VERIFICATION_TIERS,
  isDecidablePredicate,
  isVerificationTier,
} from './contract.ts';
// First-class contract v2 union. Also available namespaced as ContractV2.* for
// callers that disambiguate (e.g. ContractV2.Deliverable, ContractV2.DELIVERABLE_KINDS).
export * as ContractV2 from './contract.ts';
export type {
  Deliverable,
  DeliverableKind,
  ContractStatus,
  JsonSchema,
} from './contract.ts';
export {
  CONTRACT_STATUSES,
  DELIVERABLE_KINDS,
  isContractStatus,
  isDeliverableKind,
} from './contract.ts';
export {
  deriveAcceptanceCriteriaV2,
  KINDS_REQUIRING_EVIDENCE,
  REPO_CHECK_DEFAULT_TIMEOUT_MS,
  proseAttachmentName,
} from './ac-derivation.ts';
export { expectedOutputRequiresWorkItem } from './work-item-policy.ts';
export type { PodDefault } from './pod-defaults.ts';
export {
  POD_DEFAULT_EXPECTED_OUTPUT,
  getPodDefault,
  getPodDefaultExpectedOutput,
} from './pod-defaults.ts';
export type {
  EvaluationContext,
  EvaluationResult,
  PredicateExecutors,
  PredicateFailure,
} from './ac-evaluator.ts';
export { evaluateAcceptance, evaluatePredicate } from './ac-evaluator.ts';
export type { Attachment, AttachmentSource } from './attachment.ts';
export type {
  FieldSchema,
  FieldSchemaType,
  ValidateFieldsOk,
  ValidateFieldsErrors,
  ValidateFieldsResult,
  ValidateFieldsOptions,
} from './field-schema.ts';
export { validateFields } from './field-schema.ts';
export type { Project, ProjectSettings, Stage } from './project.ts';
export {
  defaultProjectSettings,
  postMoveStatusForStage,
  resolveCancelledHidden,
  resolveRemoteControlEnabled,
  withProjectSettingsDefaults,
} from './project.ts';
// ☠ M6 slice D (2026-06-04): the v1 workflow domain modules (workflow.ts /
// workflow-run.ts / workflow-edges.ts — BashNode, DagNode, the dead
// 'in-progress'/'complete' run statuses, EdgeRef, …) are DELETED WHOLE. They
// were unreferenced scaffolding since 19.12; WorkflowV2 is the one surface.
export * as WorkflowV2 from './workflow-v2.ts';
export type {
  WorkflowAuditField,
  WorkflowAuditRow,
  WorkflowOrigin,
  WorkflowRow,
  WorkflowRowStatus,
} from './workflow-row.ts';
export { WORKFLOW_AUDIT_FIELDS } from './workflow-row.ts';
export type {
  OrchestratorSession,
  ProviderId,
  SessionEndedReason,
  SessionStatus,
} from './orchestrator.ts';
export type {
  ActivityPanelSettings,
  AgentDispatchSettings,
  FontGroup,
  FontKey,
  FontSettings,
  GlobalSettings,
  JsonlSettings,
  OrchestratorSurfacePreference,
} from './settings.ts';
export {
  AGENT_ACK_TIMEOUT_MS_MAX,
  AGENT_ACK_TIMEOUT_MS_MIN,
  AGENT_MAX_CONCURRENT_MAX,
  AGENT_MAX_CONCURRENT_MIN,
  FONT_GROUP_DEFAULTS,
  FONT_KEYS,
  JSONL_RETENTION_DAYS_MAX,
  JSONL_RETENTION_DAYS_MIN,
  MONO_FONT_KEYS,
  clampAckTimeoutMs,
  clampFontScale,
  clampMaxConcurrent,
  defaultGlobalSettings,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  normalizeFontKey,
  normalizeFontSettings,
  normalizeJsonlRetention,
  normalizeOrchestratorSurfacePreference,
  resolveClaudeConfigDirEnv,
  withSettingsDefaults,
} from './settings.ts';
export type { Worktree, WorktreeStatus } from './worktree.ts';

// Slice 1 (Areas + context model) — roll-up decision engine.
export { workflowToMermaid } from './workflow-mermaid.ts';
export {
  decideContractCompletion,
  planRollUp,
} from './roll-up.ts';
export type {
  ContractCompletionDecision,
  PlanRollUpInput,
  WorkItemSnapshot,
} from './roll-up.ts';
export type {
  AgentColor,
  AgentDef,
  AgentEffort,
  AgentHookEntry,
  AgentHooks,
  AgentIsolation,
  AgentMcpServerRef,
  AgentMemoryScope,
  AgentModel,
  AgentModelShort,
  AgentPermissionMode,
  AgentValidationErr,
  AgentValidationIssue,
  AgentValidationOk,
  AgentValidationResult,
  InlineMcpServer,
} from './agent.ts';
export {
  AGENT_COLORS,
  AGENT_EFFORTS,
  AGENT_MEMORY_SCOPES,
  AGENT_MODEL_SHORTCUTS,
  AGENT_PERMISSION_MODES,
  validateAgentDef,
} from './agent.ts';
export type {
  AgentParseError,
  AgentParseOk,
  AgentParseResult,
  ParsedAgentFile,
  SerializeAgentFileInput,
} from './agent-file.ts';
export { parseAgentFile, serializeAgentFile } from './agent-file.ts';
export type {
  AgentContextDoc,
  AgentMcpAttachmentRow,
  CredentialAuthState,
  CredentialKind,
  CredentialRow,
  McpDiscoveryStatus,
  McpServerRegistryRow,
  PodAgentRow,
  PodAuditActor,
  PodAuditField,
  PodAuditRow,
  PodMcpServerConfig,
  PodMcpServerRow,
  PodOrigin,
  PodScope,
  PodSecretRow,
  PodSpawnBundle,
} from './pod.ts';
export {
  CREDENTIAL_AUTH_STATES,
  MCP_DISCOVERY_STATUSES,
  POD_AUDIT_ACTORS,
  POD_AUDIT_FIELDS,
  POD_SCOPES,
} from './pod.ts';
export type { SubagentFailureCause, SubagentFailureSignal } from './subagent-failure.ts';
export type { ToolCatalogEntry, ToolCatalogSource } from './tool-catalog.ts';
export {
  REQUIRED_AGENT_TOOLS,
  TOOL_CATALOG,
  descriptionOf,
  friendlyName,
  lookupTool,
  mergeRequiredAgentTools,
} from './tool-catalog.ts';
export type {
  CapabilityFamily,
  JsonSchemaObject,
  PcRigToolDef,
  PcRigToolTier,
} from './tool-registry.ts';
export {
  PC_RIG_TOOL_REGISTRY,
  PC_RIG_TOOL_REGISTRY_NAMES,
  PC_RIG_TOOL_TIERS,
} from './tool-registry.ts';
export type {
  AgentApprovalRequestPayload,
  AgentAsksOrchestratorPayload,
  AgentChannelEventKind,
  AgentChannelEventPayload,
  AgentCompletedPayload,
  AgentFailedPayload,
  PcAnswerPendingInput,
  PcAnswerPendingResult,
  PcAnswerPendingResultError,
  PcAnswerPendingResultOk,
  PcAskOrchestratorInput,
  PcAskOrchestratorResult,
  PcInvokeAgentInput,
  PcInvokeAgentResult,
  PcInvokeAgentResultAsync,
  PcInvokeAgentResultError,
  PcRequestApprovalInput,
  PcRequestApprovalResult,
  PendingAskOption,
} from './agent-comms.ts';
export { AGENT_CHANNEL_EVENT_KINDS } from './agent-comms.ts';
export type {
  // ☠ M4a: AgentDeliveryAuditRow / AgentInboxDriver / AgentInboxRow /
  // AgentInboxStatus deleted with the agent_inbox tables. AgentInboxEventKind
  // survives — it names the mailbox delivery envelope kinds.
  AgentInboxEventKind,
  AgentRunFailureCause,
  AgentRunRow,
  AgentRunStatus,
  PendingAskKind,
  PendingAskRow,
  PendingAskStatus,
} from './agent-system.ts';
export {
  AGENT_INBOX_EVENT_KINDS,
  AGENT_RUN_FAILURE_CAUSES,
  AGENT_RUN_STATUSES,
  PENDING_ASK_KINDS,
  PENDING_ASK_STATUSES,
} from './agent-system.ts';
