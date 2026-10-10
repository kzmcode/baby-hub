// 服薬実績の判定（純粋関数）
export interface DoseEventLike {
  id: string;
  occurredAt: Date;
  caregiverUid?: string | null;
  medicationId: string;
}

/** 薬ごとの最後の投与実績（記録上） */
export function lastDoseOf(medicationId: string, events: DoseEventLike[]): DoseEventLike | null {
  let best: DoseEventLike | null = null;
  for (const e of events) {
    if (e.medicationId !== medicationId) continue;
    if (!best || e.occurredAt.getTime() > best.occurredAt.getTime()) best = e;
  }
  return best;
}

/** 薬ごとの最終投与マップ */
export function lastDoseMap(events: DoseEventLike[]): Map<string, DoseEventLike> {
  const m = new Map<string, DoseEventLike>();
  for (const e of events) {
    const cur = m.get(e.medicationId);
    if (!cur || e.occurredAt.getTime() > cur.occurredAt.getTime()) m.set(e.medicationId, e);
  }
  return m;
}

/** 薬の有効期間内か（日付文字列 yyyy-MM-dd で比較。期限未設定は有効） */
export function isMedicationInPeriod(m: { startDate?: string; endDate?: string }, today: string): boolean {
  if (m.startDate && today < m.startDate) return false;
  if (m.endDate && today > m.endDate) return false;
  return true;
}
