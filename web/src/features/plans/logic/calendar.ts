import { addDaysStr } from '../../../lib/time';

/** Civil dates are calculated in UTC so browser timezone and DST cannot shift cells. */
export function isCalendarDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number(value.slice(0, 4)) >= 1000
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function shiftCalendarMonth(date: string, offset: number): string {
  const [year, month] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10);
}

/** Sunday-first, complete weeks, including the adjacent month's dates. */
export function calendarDays(date: string): string[] {
  const first = `${date.slice(0, 7)}-01`;
  const weekday = new Date(`${first}T00:00:00Z`).getUTCDay();
  const next = shiftCalendarMonth(first, 1);
  const dayCount = new Date(`${addDaysStr(next, -1)}T00:00:00Z`).getUTCDate();
  const count = Math.ceil((weekday + dayCount) / 7) * 7;
  return Array.from({ length: count }, (_, i) => addDaysStr(first, i - weekday));
}
