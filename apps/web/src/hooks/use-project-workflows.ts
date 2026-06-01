// Section 19.18 — Project workflows hook (mirrors `use-project-pods.ts`).
//
// Reads the DB-backed `/api/workflows?projectId=…` surface (globals ∪
// project-scope rows for the active project).
//
// Slice 015b — definition changes now arrive ONLY via the canonical relay
// `live-event` frame (entity `workflow-definition`, `workflow.definition.changed`,
// drained from the in-txn `live_outbox` row). The legacy `workflow-changed`
// envelope + its delta-apply path are gone. Defs refetch HTTP truth on any
// matching frame (refetch-on-change: the list endpoint already applies the
// project-visibility filter — globals ∪ this project's rows — so no per-frame
// scope guard is needed). The relay frame's scope (project vs global → all) is
// honored by which sockets receive it; a global def frame carries projectId
// null and reaches every project, which is exactly the refetch trigger we want.

import { useEffect, useMemo, useState } from 'react';

import type { Project, ULID } from '@/features/projects/client';
import { workflowsApi, type WorkflowRow } from '@/features/workflows/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useLiveEntitySignature } from '@/store/live-store';

export function useProjectWorkflows(
  project: Project | null,
  // Retained for signature stability; definition changes now come from the store.
  _events: WsEnvelope[],
): { workflows: WorkflowRow[]; refetch: () => void } {
  const [map, setMap] = useState<Map<ULID, WorkflowRow>>(() => new Map());

  useEffect(() => {
    if (!project) {
      setMap(new Map());
      return;
    }
    let cancelled = false;
    void workflowsApi.listWorkflowRows(project.id).then((list) => {
      if (cancelled) return;
      setMap(new Map(list.map((w) => [w.id, w])));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Slice 018 — refetch HTTP truth whenever the workflow-definition frame set
  // changes in the identity-keyed live store. Global defs carry projectId null
  // and reach every project (the signature includes them); the list endpoint
  // already applies the globals ∪ this-project visibility filter.
  const defSig = useLiveEntitySignature('workflow-definition', project?.id ?? null);
  useEffect(() => {
    if (!project || !defSig) return;
    void workflowsApi.listWorkflowRows(project.id).then((list) => {
      setMap(new Map(list.map((w) => [w.id, w])));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defSig, project?.id]);

  const workflows = useMemo(
    () =>
      Array.from(map.values()).sort((a, b) => {
        // This project first, then global; alpha within.
        if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [map],
  );

  return {
    workflows,
    refetch: () => {
      if (!project) return;
      void workflowsApi.listWorkflowRows(project.id).then((list) => {
        setMap(new Map(list.map((w) => [w.id, w])));
      });
    },
  };
}
