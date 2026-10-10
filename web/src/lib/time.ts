// タイムゾーン・日付境界ユーティリティ（家族のタイムゾーンは既定 Asia/Tokyo）
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import { addDays, parseISO } from 'date-fns';

export const TZ = 'Asia/Tokyo';

/** Date を yyyy-MM-dd（TZ基準）へ */
export function toDateStr(d: Date, tz = TZ): string {
  return formatInTimeZone(d, tz, 'yyyy-MM-dd');
}

export function todayStr(now: Date = new Date(), tz = TZ): string {
  return toDateStr(now, tz);
}

/** yyyy-MM-dd に n 日足した文字列 */
export function addDaysStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + n);
  return base.toISOString().slice(0, 10);
}

/** その日（TZ）の [start, end) を返す。end は翌日 0:00 */
export function dayRange(dateStr: string, tz = TZ): { start: Date; end: Date } {
  const start = fromZonedTime(`${dateStr}T00:00:00`, tz);
  const end = fromZonedTime(`${addDaysStr(dateStr, 1)}T00:00:00`, tz);
  return { start, end };
}

/** 複数日の範囲 [startDate 0:00, endDate の翌日 0:00) */
export function rangeOfDays(startDate: string, endDate: string, tz = TZ): { start: Date; end: Date } {
  return { start: dayRange(startDate, tz).start, end: dayRange(endDate, tz).end };
}

/** "HH:mm" */
export function formatTime(d: Date, tz = TZ): string {
  return formatInTimeZone(d, tz, 'HH:mm');
}

/** "M月d日(曜)" */
export function formatDateJa(dateStr: string): string {
  const d = parseISO(dateStr);
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日(${w})`;
}

/** 「今日」「昨日」「明日」or M月d日(曜) */
export function formatDateLabel(dateStr: string, now: Date = new Date(), tz = TZ): string {
  const t = todayStr(now, tz);
  if (dateStr === t) return '今日';
  if (dateStr === addDaysStr(t, -1)) return '昨日';
  if (dateStr === addDaysStr(t, 1)) return '明日';
  return formatDateJa(dateStr);
}

/** 経過時間「たった今」「15分前」「2時間15分前」「1日3時間前」 */
export function formatElapsed(from: Date, now: Date = new Date()): string {
  const min = Math.floor((now.getTime() - from.getTime()) / 60000);
  if (min < 0) return '未来の時刻';
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m === 0 ? `${h}時間前` : `${h}時間${m}分前`;
  const days = Math.floor(h / 24);
  const hh = h % 24;
  return hh === 0 ? `${days}日前` : `${days}日${hh}時間前`;
}

/** 長さ（秒）→「1時間20分」「45分」 */
export function formatDuration(seconds: number): string {
  const min = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分`;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

/** 月齢「生後3か月」「生後2か月15日」ほか。出生日未設定は null */
export function formatAge(birthDate: string | null | undefined, now: Date = new Date(), tz = TZ): string | null {
  if (!birthDate) return null;
  const t = todayStr(now, tz);
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = t.split('-').map(Number);
  if (t < birthDate) return null;
  let months = (ty - by) * 12 + (tm - bm);
  if (td < bd) months -= 1;
  if (months < 1) {
    const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(by, bm - 1, bd)) / 86400000);
    return `生後${days}日`;
  }
  if (months < 24) return `${months}か月`;
  const y = Math.floor(months / 12);
  const r = months % 12;
  return r === 0 ? `${y}歳` : `${y}歳${r}か月`;
}

/** "HH:mm" と日付文字列から Date（TZ基準） */
export function combineDateTime(dateStr: string, hhmm: string, tz = TZ): Date {
  return fromZonedTime(`${dateStr}T${hhmm}:00`, tz);
}

/** 静穏時間内か（start>end は日跨ぎ） */
export function isInQuietHours(d: Date, start: string, end: string, tz = TZ): boolean {
  const cur = formatTime(d, tz);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** TZ での現地時刻（表示計算用）。date-fns の関数に渡すとき用 */
export function zoned(d: Date, tz = TZ): Date {
  return toZonedTime(d, tz);
}

export { addDays };
