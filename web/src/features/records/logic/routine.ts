import { dayRange } from '../../../lib/time';
import { clipInterval } from './interval';
import type { SleepSession } from './sleep';
import type { Ev } from './types';

export interface SleepBand {
  sessionId: string;
  /** その日の 0:00 からの分 */
  startMin: number;
  endMin: number;
  kind: 'closed' | 'open' | 'conflict';
}

export type MarkerKind =
  | 'breast' | 'formula' | 'expressed' | 'pumping'
  | 'urine' | 'stool' | 'both' | 'diaper_only' | 'diaper_unknown'
  | 'vomit' | 'bath' | 'other';

export interface Marker {
  eventId: string;
  minute: number;
  kind: MarkerKind;
}

export interface DayRoutine {
  date: string;
  bands: SleepBand[];
  markers: Marker[];
  /** 現在時刻が当日内なら、その分。過去日は 1440、未来日は 0 */
  nowMin: number;
}

export function markerKindOf(e: Ev): MarkerKind | null {
  switch (e.type) {
    case 'feeding': {
      const m = e.payload.method;
      return m === 'breast' ? 'breast' : m === 'formula' ? 'formula' : 'expressed';
    }
    case 'pumping': return 'pumping';
    case 'diaper': {
      const u = e.payload.urine, s = e.payload.stool;
      if (u === 'yes' && s === 'yes') return 'both';
      if (u === 'yes') return 'urine';
      if (s === 'yes') return 'stool';
      if (u === 'unknown' || s === 'unknown') return 'diaper_unknown';
      return 'diaper_only';
    }
    case 'vomit': return 'vomit';
    case 'bath': return 'bath';
    case 'memo': return 'other';
    default: return null;
  }
}

const toMin = (d: Date, base: Date) => Math.round(((d.getTime() - base.getTime()) / 60000) * 100) / 100;

/**
 * 1日分の生活リズムを作る。睡眠は日付境界で切る（跨ぐ睡眠は両日に分割して表示）。
 * 現在時刻以降は描かない（未終了は現在まで）。実施者フィルタは markers のみに適用し、帯は保持する。
 */
export function buildDayRoutine(
  events: Ev[],
  sessions: SleepSession[],
  dateStr: string,
  now: Date = new Date(),
  filter?: (e: Ev) => boolean,
): DayRoutine {
  const { start, end } = dayRange(dateStr);
  const bands: SleepBand[] = [];
  for (const ss of sessions) {
    if (ss.state === 'closed' && ss.start && ss.end) {
      const c = clipInterval(ss.start, ss.end, start, end);
      const c2 = c && clipInterval(c.start, c.end, start, now);
      if (c2) bands.push({ sessionId: ss.sessionId, startMin: toMin(c2.start, start), endMin: toMin(c2.end, start), kind: 'closed' });
    } else if (ss.state === 'open' && ss.start) {
      const c = clipInterval(ss.start, now, start, end);
      if (c) bands.push({ sessionId: ss.sessionId, startMin: toMin(c.start, start), endMin: toMin(c.end, start), kind: 'open' });
    } else if (ss.state === 'conflict' && ss.start && !ss.end) {
      // 矛盾した未終了の開始。現在までを確認待ちとして表示
      const c = clipInterval(ss.start, now, start, end);
      if (c) bands.push({ sessionId: ss.sessionId, startMin: toMin(c.start, start), endMin: toMin(c.end, start), kind: 'conflict' });
    } else if (ss.state === 'conflict' && ss.start && ss.end && ss.end > ss.start) {
      const c = clipInterval(ss.start, ss.end, start, end);
      if (c) bands.push({ sessionId: ss.sessionId, startMin: toMin(c.start, start), endMin: toMin(c.end, start), kind: 'conflict' });
    }
  }
  const markers: Marker[] = [];
  for (const e of events) {
    if (e.status !== 'active') continue;
    if (e.occurredAt < start || e.occurredAt >= end || e.occurredAt > now) continue;
    if (filter && !filter(e)) continue;
    const kind = markerKindOf(e);
    if (kind) markers.push({ eventId: e.id, minute: toMin(e.occurredAt, start), kind });
  }
  const nowMin = now >= end ? 1440 : now < start ? 0 : toMin(now, start);
  return { date: dateStr, bands, markers, nowMin };
}
