// health feature 内の共通フック・部品
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { limit, orderBy, query, where, Timestamp, type Query } from 'firebase/firestore';
import { useFamily } from '../../context';
import { paths, useCollection, type WithMeta } from '../../lib/db';
import { api, apiErrorMessage, ApiError, type DocKind } from '../../lib/api';
import { combineDateTime, formatTime, toDateStr } from '../../lib/time';
import { SegmentedControl, TimeInput, CategoryIcon } from '../../components';
import type { DailyEvent, EventType } from '../../types/models';
import type { LogEvent } from './logic/summary';
import './health.css';

export function useIds() {
  const { familyId, childId, loading } = useFamily();
  return { familyId, childId, loading };
}

export function tsToDate(t: unknown): Date {
  return t instanceof Timestamp ? t.toDate() : t instanceof Date ? t : new Date(0);
}

export function toLogEvent(e: WithMeta<DailyEvent>): LogEvent {
  return {
    id: e.id,
    type: e.type,
    occurredAt: tsToDate(e.occurredAt),
    endedAt: e.endedAt ? tsToDate(e.endedAt) : undefined,
    payload: e.payload as unknown as Record<string, unknown>,
    caregiverUid: e.caregiverUid,
    note: e.note,
  };
}

/** 種別を指定した直近の有効イベント（新しい順） */
export function useRecentEvents(types: EventType[], max: number) {
  const { familyId, childId } = useIds();
  const key = types.join(',');
  const q: Query | null = useMemo(
    () =>
      familyId && childId
        ? query(paths.events(familyId, childId), where('type', 'in', key.split(',')), where('status', '==', 'active'), orderBy('occurredAt', 'desc'), limit(max))
        : null,
    [familyId, childId, key, max],
  );
  return useCollection<DailyEvent>(q);
}

/** 期間 [start, end) の有効イベント（古い順） */
export function useEventsBetween(start: Date, end: Date) {
  const { familyId, childId } = useIds();
  const s = start.getTime();
  const e = end.getTime();
  const q: Query | null = useMemo(
    () =>
      familyId && childId
        ? query(
            paths.events(familyId, childId),
            where('status', '==', 'active'),
            where('occurredAt', '>=', Timestamp.fromMillis(s)),
            where('occurredAt', '<', Timestamp.fromMillis(e)),
            orderBy('occurredAt', 'asc'),
          )
        : null,
    [familyId, childId, s, e],
  );
  return useCollection<DailyEvent>(q);
}

/** updateDoc の保存と競合状態を扱う */
export function useSaver() {
  const { familyId, childId } = useIds();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflictRev, setConflictRev] = useState<number | null>(null);
  const clear = useCallback(() => { setError(''); setConflictRev(null); }, []);
  const save = useCallback(
    async (kind: DocKind, docId: string, revision: number, patch: Record<string, unknown>, withChild = true): Promise<boolean> => {
      if (!familyId) return false;
      setSaving(true);
      setError('');
      try {
        await api.updateDoc({ familyId, kind, childId: withChild ? childId ?? undefined : undefined, docId, expectedRevision: conflictRev ?? revision, patch });
        setConflictRev(null);
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.isConflict && e.conflict) setConflictRev(e.conflict.currentRevision);
        else setError(apiErrorMessage(e));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [familyId, childId, conflictRev],
  );
  return { save, saving, error, conflict: conflictRev !== null, clear };
}

/** 時刻の入力（既定「今」。保存時の現在時刻を使う） */
export interface When { mode: 'now' | 'custom'; at: Date }
export const newWhen = (): When => ({ mode: 'now', at: new Date() });
export const resolveWhen = (w: When): Date => (w.mode === 'now' ? new Date() : w.at);

export function WhenField({ value, onChange, label = '時刻' }: { value: When; onChange: (w: When) => void; label?: string }) {
  return (
    <div className="stack">
      <SegmentedControl
        ariaLabel={`${label}の指定方法`}
        value={value.mode}
        onChange={(mode) => onChange({ mode, at: mode === 'custom' ? new Date() : value.at })}
        options={[{ value: 'now', label: '保存した時刻' }, { value: 'custom', label: '時刻を指定' }]}
      />
      {value.mode === 'custom' && <TimeInput label={label} withDate value={value.at} onChange={(at) => onChange({ mode: 'custom', at })} />}
    </div>
  );
}

export function PageHeader({ title, back = '/health', actions }: { title: string; back?: string; actions?: ReactNode }) {
  return (
    <div className="hl-head">
      <Link to={back} className="ch-iconbtn" aria-label="戻る"><CategoryIcon name="chevronLeft" /></Link>
      <h1>{title}</h1>
      {actions && <div className="hl-head__actions">{actions}</div>}
    </div>
  );
}

export function dateTimeText(d: Date): string {
  return `${toDateStr(d).slice(5).replace('-', '/')} ${formatTime(d)}`;
}

export { combineDateTime };
