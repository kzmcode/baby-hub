/** [s,e) を [rs,re) に切り取る。重なりが無ければ null */
export function clipInterval(s: Date, e: Date, rs: Date, re: Date): { start: Date; end: Date } | null {
  const a = Math.max(s.getTime(), rs.getTime());
  const b = Math.min(e.getTime(), re.getTime());
  return b > a ? { start: new Date(a), end: new Date(b) } : null;
}

/** 分（ms→分） */
export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60000;
}
