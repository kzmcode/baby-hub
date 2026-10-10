import type { DailyEvent } from '../../../types/models';
import type { WithMeta } from '../../../lib/db';

/** 購読で得られる記録（_pending 付き） */
export type EventDoc = WithMeta<DailyEvent>;

/** ロジック層で使う、Timestamp を Date にした最小表現 */
export interface Ev {
  id: string;
  type: DailyEvent['type'];
  occurredAt: Date;
  endedAt?: Date;
  caregiverUid?: string | null;
  createdBy: string;
  sessionId?: string;
  payload: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  note?: string;
  contextEventIds?: string[];
  status: 'active' | 'void';
  revision: number;
  pending: boolean;
}

export function toEv(d: EventDoc): Ev {
  return {
    id: d.id,
    type: d.type,
    occurredAt: d.occurredAt.toDate(),
    endedAt: d.endedAt ? d.endedAt.toDate() : undefined,
    caregiverUid: d.caregiverUid,
    createdBy: d.createdBy,
    sessionId: d.sessionId ?? (d.payload as { sessionId?: string }).sessionId,
    payload: d.payload as Record<string, unknown>,
    note: d.note,
    contextEventIds: d.contextEventIds,
    status: d.status,
    revision: d.revision,
    pending: d._pending,
  };
}
