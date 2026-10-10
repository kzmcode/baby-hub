import type { Ev } from './types';

export const FEEDING_TYPES: Ev['type'][] = ['feeding'];

export interface Reflection {
  /** 範囲内の記録（対象を含む、実施時刻順） */
  inRange: Ev[];
  /** 対象より前で最も近い哺乳（範囲内にあれば inRange にも含まれる） */
  previousFeeding: Ev | null;
  /** previousFeeding が選択範囲より前にある */
  previousFeedingOutOfRange: boolean;
  /** 対象から previousFeeding までの分 */
  minutesSincePreviousFeeding: number | null;
}

/**
 * 対象の前 beforeMin 分〜後 afterMin 分の記録を時系列に並べる。
 * 「原因」の判定はしない。時間の前後関係のみ。
 * candidates は範囲より前の哺乳も含み得る（直前の哺乳を拾うため）。
 */
export function buildReflection(target: Ev, candidates: Ev[], beforeMin: number, afterMin: number): Reflection {
  const t = target.occurredAt.getTime();
  const from = t - beforeMin * 60000;
  const to = t + afterMin * 60000;
  const active = candidates.filter((e) => e.status === 'active' && e.id !== target.id);
  const inRange = [...active.filter((e) => e.occurredAt.getTime() >= from && e.occurredAt.getTime() <= to), target].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id === target.id ? 1 : -1),
  );
  const prev = active
    .filter((e) => e.type === 'feeding' && e.occurredAt.getTime() <= t)
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0] ?? null;
  return {
    inRange,
    previousFeeding: prev,
    previousFeedingOutOfRange: !!prev && prev.occurredAt.getTime() < from,
    minutesSincePreviousFeeding: prev ? Math.round((t - prev.occurredAt.getTime()) / 60000) : null,
  };
}
