const MIN_SEC_OFFSET = 62135596800; // 0001-01-01 までの秒数（valueOf の比較用）

export class Timestamp {
  readonly seconds: number;
  readonly nanoseconds: number;
  constructor(seconds: number, nanoseconds: number) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }
  static fromDate(d: Date): Timestamp {
    return Timestamp.fromMillis(d.getTime());
  }
  static fromMillis(ms: number): Timestamp {
    const seconds = Math.floor(ms / 1000);
    return new Timestamp(seconds, Math.round((ms - seconds * 1000) * 1e6));
  }
  /** Firestore REST の RFC3339 文字列（ナノ秒まで）から生成 */
  static fromISO(s: string): Timestamp {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(s);
    if (!m) throw new Error('Invalid timestamp string');
    const ms = Date.parse(`${m[1]}${m[3]}`);
    if (Number.isNaN(ms)) throw new Error('Invalid timestamp string');
    const nanos = m[2] ? Number((m[2] + '000000000').slice(0, 9)) : 0;
    return new Timestamp(ms / 1000, nanos);
  }
  toDate(): Date {
    return new Date(this.toMillis());
  }
  toMillis(): number {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }
  isEqual(t: Timestamp): boolean {
    return t instanceof Timestamp && t.seconds === this.seconds && t.nanoseconds === this.nanoseconds;
  }
  /** REST 用の RFC3339（UTC、ナノ秒 9 桁） */
  toRfc3339(): string {
    const base = new Date(this.seconds * 1000).toISOString().slice(0, 19);
    return `${base}.${String(this.nanoseconds).padStart(9, '0')}Z`;
  }
  /** JSON.stringify では ISO 文字列になる（Web へそのまま返せる） */
  toJSON(): string {
    return this.toDate().toISOString();
  }
  /** `a < b` のような大小比較が使える（admin SDK と同じ文字列表現）。厳密比較は toMillis() か isEqual() を使うこと */
  valueOf(): string {
    return `${String(this.seconds + MIN_SEC_OFFSET).padStart(12, '0')}.${String(this.nanoseconds).padStart(9, '0')}`;
  }
}
