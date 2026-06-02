// Slice 013 — Agent contracts API client. Mirrors the areasApi fetch pattern.
// Read-only this slice: a contract detail fetch + a work item's contract
// timeline (the "work log"). Authoring/submission UI lands in slice 014.

import { getJson } from '@/api/http';
import type { ULID } from '@/features/projects/types';
import {
  contractRoutes,
  type Contract,
  type ContractDetailResponse,
  type ListContractsResponse,
} from '@pc/contracts';

export type { Contract };

export const contractsApi = {
  /** One contract by id. Throws on 404 (the route returns `{ok:false,error}`). */
  getContract: (id: ULID): Promise<Contract> =>
    getJson<ContractDetailResponse>(contractRoutes.detail(id)).then((r) => r.contract),

  /** A work item's contract timeline, oldest-first. Empty array when none
   *  (the route returns `{ok:true,contracts:[]}`, NOT a 404). */
  getWorkItemContracts: (workItemId: ULID): Promise<Contract[]> =>
    getJson<ListContractsResponse>(contractRoutes.forWorkItem(workItemId)).then(
      (r) => r.contracts,
    ),
};
