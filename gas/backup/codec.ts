// バックアップ用シリアライズ。Timestamp は { "__ts": "YYYY-MM-DDTHH:mm:ss.nnnnnnnnnZ" }（ナノ秒まで往復可能）。
// 外部依存なし（Timestamp は duck typing、復元時は生成関数を注入）。

export interface TsLike { seconds: number; nanoseconds: number; toMillis(): number }

export function isTsLike(v: unknown): v is TsLike {
  return !!v && typeof v === 'object' && typeof (v as TsLike).seconds === 'number'
    && typeof (v as TsLike).nanoseconds === 'number' && typeof (v as TsLike).toMillis === 'function';
}

export function tsToIso(seconds: number, nanoseconds: number): string {
  const base = new Date(seconds * 1000).toISOString().slice(0, 19); // YYYY-MM-DDTHH:mm:ss
  return `${base}.${String(nanoseconds).padStart(9, '0')}Z`;
}

export function isoToTs(iso: string): { seconds: number; nanoseconds: number } {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(iso);
  if (!m) throw new Error('Invalid __ts value');
  const seconds = Math.floor(Date.parse(m[1] + 'Z') / 1000);
  const nanoseconds = m[2] ? Number(m[2].padEnd(9, '0')) : 0;
  return { seconds, nanoseconds };
}

export function encodeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (isTsLike(v)) return { __ts: tsToIso(v.seconds, v.nanoseconds) };
  if (v instanceof Date) return { __ts: tsToIso(Math.floor(v.getTime() / 1000), (v.getTime() % 1000) * 1e6) };
  if (Array.isArray(v)) return v.map(encodeValue);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) out[k] = encodeValue(x);
    return out;
  }
  return v;
}

export function decodeValue<T>(v: unknown, mk: (seconds: number, nanoseconds: number) => T): unknown {
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, mk));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '__ts' && typeof o.__ts === 'string') {
      const t = isoToTs(o.__ts);
      return mk(t.seconds, t.nanoseconds);
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = decodeValue(o[k], mk);
    return out;
  }
  return v;
}

/** 端末の FCM トークンはバックアップに含めない */
export function isDevicePath(path: string): boolean {
  return /^users\/[^/]+\/devices\/[^/]+$/.test(path);
}
export function encodeDoc(path: string, data: Record<string, unknown>): { path: string; data: unknown } {
  const enc = encodeValue(data) as Record<string, unknown>;
  if (isDevicePath(path)) delete enc.fcmToken;
  return { path, data: enc };
}
