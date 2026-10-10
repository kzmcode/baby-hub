// JS 値 <-> Firestore REST Value の相互変換
import { FieldValueSentinel } from './field-value';
import { Timestamp } from './timestamp';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Value = Record<string, any>;
export type Fields = Record<string, Value>;

/** DocumentReference の判別（循環 import を避けるためダックタイピング） */
export interface RefLike { readonly path: string; readonly _isDocRef: true }
export const isRefLike = (v: unknown): v is RefLike =>
  typeof v === 'object' && v !== null && (v as RefLike)._isDocRef === true && typeof (v as RefLike).path === 'string';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** `root` は projects/{p}/databases/(default)/documents */
export function toValue(v: unknown, root: string): Value {
  if (v === null) return { nullValue: null };
  switch (typeof v) {
    case 'boolean': return { booleanValue: v };
    case 'string': return { stringValue: v };
    case 'number':
      if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER && !Object.is(v, -0)) return { integerValue: String(v) };
      if (Number.isNaN(v)) return { doubleValue: 'NaN' };
      if (v === Infinity) return { doubleValue: 'Infinity' };
      if (v === -Infinity) return { doubleValue: '-Infinity' };
      return { doubleValue: v };
    case 'undefined': throw new Error('undefined is not a valid Firestore value');
    case 'object': break;
    default: throw new Error(`Unsupported Firestore value type: ${typeof v}`);
  }
  if (v instanceof Timestamp) return { timestampValue: v.toRfc3339() };
  if (v instanceof Date) return { timestampValue: Timestamp.fromDate(v).toRfc3339() };
  if (isRefLike(v)) return { referenceValue: `${root}/${v.path}` };
  if (v instanceof FieldValueSentinel) throw new Error('FieldValue is not allowed here');
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => toValue(x, root)) } };
  if (isPlainObject(v)) return { mapValue: { fields: toFields(v, root) } };
  throw new Error('Unsupported Firestore value (custom object)');
}

/** undefined のプロパティは無視する */
export function toFields(o: Record<string, unknown>, root: string): Fields {
  const out: Fields = {};
  for (const [k, x] of Object.entries(o)) if (x !== undefined) out[k] = toValue(x, root);
  return out;
}

export function fromValue(v: Value, root: string, makeRef: (path: string) => unknown): unknown {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue as boolean;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) {
    const d = v.doubleValue;
    return typeof d === 'string' ? Number(d) : (d as number);
  }
  if ('stringValue' in v) return v.stringValue as string;
  if ('timestampValue' in v) return Timestamp.fromISO(v.timestampValue as string);
  if ('referenceValue' in v) {
    const name = v.referenceValue as string;
    return makeRef(name.startsWith(root + '/') ? name.slice(root.length + 1) : name);
  }
  if ('arrayValue' in v) return ((v.arrayValue.values ?? []) as Value[]).map((x) => fromValue(x, root, makeRef));
  if ('mapValue' in v) return fromFields((v.mapValue.fields ?? {}) as Fields, root, makeRef);
  if ('bytesValue' in v) return v.bytesValue as string;
  if ('geoPointValue' in v) return v.geoPointValue;
  throw new Error('Unsupported Firestore value from server');
}

export function fromFields(f: Fields, root: string, makeRef: (path: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(f)) out[k] = fromValue(x, root, makeRef);
  return out;
}
