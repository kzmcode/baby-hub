import { useMemo } from 'react';
import { limit, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { useFamily } from '../../context';
import { paths, useCollection } from '../../lib/db';
import type { DailyEvent, EventType } from '../../types/models';
import { buildSleepSessions, type SleepSession } from './logic/sleep';
import { toEv, type Ev, type EventDoc } from './logic/types';

const DAY = 86400000;

export interface EventsState {
  events: Ev[];
  sessions: SleepSession[];
  loading: boolean;
  error: Error | null;
  fromCache: boolean;
}

/**
 * [start, end) の active な記録を購読。睡眠セッション組立のため前後に余白を取って取得する
 * （前日以前から跨ぐ睡眠・翌日に終了する睡眠）。
 * クエリ: status==active + occurredAt 範囲 + orderBy occurredAt（索引 status+occurredAt）
 */
export function useEventsRange(start: Date | null, end: Date | null, padBackDays = 1, padFwdDays = 1): EventsState {
  const { familyId, childId } = useFamily();
  const s = start ? start.getTime() - padBackDays * DAY : null;
  const e = end ? end.getTime() + padFwdDays * DAY : null;
  const q = useMemo(
    () =>
      familyId && childId && s != null && e != null
        ? query(
            paths.events(familyId, childId),
            where('status', '==', 'active'),
            where('occurredAt', '>=', Timestamp.fromMillis(s)),
            where('occurredAt', '<', Timestamp.fromMillis(e)),
            orderBy('occurredAt'),
          )
        : null,
    [familyId, childId, s, e],
  );
  const { data, loading, error, fromCache } = useCollection<DailyEvent>(q);
  const events = useMemo(() => data.map((d) => toEv(d as EventDoc)), [data]);
  const sessions = useMemo(() => buildSleepSessions(events), [events]);
  return { events, sessions, loading, error, fromCache };
}

/** 種別ごとの最新1件（索引 type+status+occurredAt） */
export function useLatestOfType(type: EventType): { event: Ev | null; loading: boolean } {
  const { familyId, childId } = useFamily();
  const q = useMemo(
    () =>
      familyId && childId
        ? query(paths.events(familyId, childId), where('type', '==', type), where('status', '==', 'active'), orderBy('occurredAt', 'desc'), limit(1))
        : null,
    [familyId, childId, type],
  );
  const { data, loading } = useCollection<DailyEvent>(q);
  return { event: data[0] ? toEv(data[0] as EventDoc) : null, loading };
}
