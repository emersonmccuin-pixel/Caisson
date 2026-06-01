// FieldSchemaService — project-scoped facade over the field-schemas repo.
//
// list + replace. Slice 015b: replace writes a durable `field-schema.list.changed`
// live_outbox row in-txn; the live-relay drains the committed row and fans the
// canonical `{type:'live-event'}` frame to the project's subscribers. The old
// hand-written `field-schemas-changed` envelope fanout is GONE.

import type { FieldSchema, ULID } from '@pc/domain';
import type { FieldSchemaListChangedLivePayload } from '@pc/contracts';
import {
  getDb,
  insertLiveEvent,
  listFieldSchemas,
  replaceFieldSchemas,
  type ReplaceFieldSchemasInput,
} from '@pc/db';

export interface FieldSchemaServiceOptions {
  projectId: ULID;
}

export class FieldSchemaService {
  constructor(private readonly opts: FieldSchemaServiceOptions) {}

  list(): FieldSchema[] {
    return listFieldSchemas(this.opts.projectId);
  }

  replace(items: ReplaceFieldSchemasInput['items']): FieldSchema[] {
    const out = replaceFieldSchemas({ projectId: this.opts.projectId, items });
    const payload: FieldSchemaListChangedLivePayload = {
      // Domain FieldSchema is structurally compatible with the contract DTO.
      schemas: out as unknown as FieldSchemaListChangedLivePayload['schemas'],
      reason: 'replaced',
    };
    getDb().transaction((tx) => {
      insertLiveEvent(tx, {
        scope: 'project',
        projectId: this.opts.projectId,
        type: 'field-schema.list.changed',
        entity: 'field-schema',
        entityId: null,
        version: null,
        payload,
      });
    });
    return out;
  }
}
