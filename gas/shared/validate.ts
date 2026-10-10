import { ApiError } from '../core/errors';
import { Timestamp } from '../core/firestore';

// ---------- 入力検証エンジン（純粋関数） ----------
// 3.3 の制約: 短文<=200 / 本文<=2000 / URLはhttpsのみ / 数値は有限・非負 / 許可外キーは拒否

export const SHORT_MAX = 200;
export const TEXT_MAX = 2000;

export type Spec =
  | { k: 'str'; min?: number; max?: number }
  | { k: 'text'; max?: number }
  | { k: 'url' }
  | { k: 'num'; min?: number; max?: number; int?: boolean }
  | { k: 'bool' }
  | { k: 'enum'; values: readonly string[] }
  | { k: 'enumArr'; values: readonly string[]; maxItems?: number }
  | { k: 'date' }
  | { k: 'iso' }
  | { k: 'strArr'; maxItems?: number; itemMax?: number }
  | { k: 'id' }
  | { k: 'uid' }
  | { k: 'uidArr'; maxItems?: number }
  | { k: 'refs' }
  | { k: 'allergies' }
  | { k: 'clinic' }
  | { k: 'obj'; fields: Record<string, Field> };

/** null: 'store' = null を保存 / 'delete' = フィールド削除 / 未指定 = null 不可 */
export interface Field { spec: Spec; null?: 'store' | 'delete' }

export interface Validated {
  set: Record<string, unknown>;
  del: string[];
  /** 検証した uid 参照（呼び出し側で有効メンバーか確認する） */
  uids: string[];
}

const bad = (key: string): never => {
  // 値は含めない（自由文・健康情報をログ/レスポンスへ出さない）
  throw new ApiError('invalid-argument', `Invalid field: ${key}`);
};

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

export function isValidDateString(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidIso(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
}

export function isValidId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 128 && !v.includes('/') && v !== '.' && v !== '..' && !/^__.*__$/.test(v);
}

export function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > TEXT_MAX) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

const REF_KINDS = ['event', 'schedule', 'task', 'shopping', 'handover', 'medicalVisit', 'vaccination', 'medication'];

function convert(key: string, spec: Spec, v: unknown, uids: string[]): unknown {
  switch (spec.k) {
    case 'str': {
      if (typeof v !== 'string') return bad(key);
      const min = spec.min ?? 1;
      if (v.length < min || v.length > (spec.max ?? SHORT_MAX)) return bad(key);
      return v;
    }
    case 'text':
      if (typeof v !== 'string' || v.length > (spec.max ?? TEXT_MAX)) return bad(key);
      return v;
    case 'url':
      return isHttpsUrl(v) ? v : bad(key);
    case 'num': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad(key);
      if (v < (spec.min ?? 0) || (spec.max !== undefined && v > spec.max)) return bad(key);
      if (spec.int && !Number.isInteger(v)) return bad(key);
      return v;
    }
    case 'bool':
      return typeof v === 'boolean' ? v : bad(key);
    case 'enum':
      return typeof v === 'string' && spec.values.includes(v) ? v : bad(key);
    case 'enumArr': {
      if (!Array.isArray(v) || v.length > (spec.maxItems ?? 50)) return bad(key);
      if (!v.every((x) => typeof x === 'string' && spec.values.includes(x))) return bad(key);
      return [...new Set(v as string[])];
    }
    case 'date':
      return isValidDateString(v) ? v : bad(key);
    case 'iso':
      return isValidIso(v) ? Timestamp.fromDate(new Date(v)) : bad(key);
    case 'strArr': {
      if (!Array.isArray(v) || v.length > (spec.maxItems ?? 20)) return bad(key);
      if (!v.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= (spec.itemMax ?? 50))) return bad(key);
      return v;
    }
    case 'id':
      return isValidId(v) ? v : bad(key);
    case 'uid':
      if (!isValidId(v)) return bad(key);
      uids.push(v as string);
      return v;
    case 'uidArr': {
      if (!Array.isArray(v) || v.length > (spec.maxItems ?? 10) || !v.every(isValidId)) return bad(key);
      uids.push(...(v as string[]));
      return [...new Set(v as string[])];
    }
    case 'refs': {
      if (!Array.isArray(v) || v.length > 20) return bad(key);
      return v.map((r) => {
        if (!isPlainObject(r)) return bad(key);
        const o = r as Record<string, unknown>;
        if (Object.keys(o).some((x) => !['kind', 'id', 'childId'].includes(x))) return bad(key);
        if (typeof o.kind !== 'string' || !REF_KINDS.includes(o.kind) || !isValidId(o.id)) return bad(key);
        if (o.childId !== undefined && !isValidId(o.childId)) return bad(key);
        return o.childId === undefined ? { kind: o.kind, id: o.id } : { kind: o.kind, id: o.id, childId: o.childId };
      });
    }
    case 'allergies': {
      if (!Array.isArray(v) || v.length > 50) return bad(key);
      const f: Record<string, Field> = {
        name: { spec: { k: 'str' } },
        confirmation: { spec: { k: 'enum', values: ['confirmed_by_doctor', 'suspected', 'unconfirmed'] } },
        source: { spec: { k: 'str' }, null: 'delete' },
        note: { spec: { k: 'text' }, null: 'delete' },
      };
      return v.map((a) => {
        const r = validateObject(f, a, { required: ['name', 'confirmation'], label: key });
        return r.set;
      });
    }
    case 'clinic': {
      const f: Record<string, Field> = {
        name: { spec: { k: 'str' } },
        phone: { spec: { k: 'str', max: 50 }, null: 'delete' },
        url: { spec: { k: 'url' }, null: 'delete' },
      };
      return validateObject(f, v, { required: ['name'], label: key }).set;
    }
    case 'obj': {
      const r = validateObject(spec.fields, v, { label: key });
      uids.push(...r.uids);
      return r.set;
    }
  }
}

/**
 * input を fields に照らして検証する。許可外のキーは invalid-argument。
 * null は Field.null に従い store / delete。required キーは存在かつ非 null 必須。
 */
export function validateObject(
  fields: Record<string, Field>,
  input: unknown,
  opts: { required?: string[]; label?: string } = {},
): Validated {
  const label = opts.label ?? 'input';
  if (!isPlainObject(input)) return bad(label);
  const out: Validated = { set: {}, del: [], uids: [] };
  for (const [key, v] of Object.entries(input)) {
    const f = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
    if (!f) return bad(`${label}.${key}`);
    if (v === undefined) continue;
    if (v === null) {
      if (f.null === 'store') out.set[key] = null;
      else if (f.null === 'delete') out.del.push(key);
      else bad(`${label}.${key}`);
      continue;
    }
    out.set[key] = convert(key, f.spec, v, out.uids);
  }
  for (const r of opts.required ?? []) {
    if (!(r in out.set) || out.set[r] === null) bad(`${label}.${r}`);
  }
  return out;
}

export function applyPatch(current: Record<string, unknown>, v: { set: Record<string, unknown>; del: string[] }): Record<string, unknown> {
  const merged = { ...current, ...v.set };
  for (const k of v.del) delete merged[k];
  return merged;
}

// ---------- 共通 ----------
export const asId = (key: string, v: unknown): string => (isValidId(v) ? v : bad(key));
export const asRevision = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : bad('expectedRevision');

// ---------- Event payload ----------
export const EVENT_TYPES = [
  'feeding', 'pumping', 'diaper', 'sleep_start', 'sleep_end', 'bath', 'vomit',
  'temperature', 'symptom', 'growth', 'medication_taken', 'meal', 'milestone', 'memo',
] as const;

const YNU = ['yes', 'no', 'unknown'] as const;
const tags: Field = { spec: { k: 'strArr', maxItems: 20, itemMax: 50 }, null: 'delete' };
const optShort = (): Field => ({ spec: { k: 'str' }, null: 'delete' });
const optText = (): Field => ({ spec: { k: 'text' }, null: 'delete' });

export const PAYLOAD_FIELDS: Record<string, Record<string, Field>> = {
  feeding: {
    method: { spec: { k: 'enum', values: ['breast', 'formula', 'expressed_breast_milk'] } },
    consumedMl: { spec: { k: 'num', min: 0, max: 500 }, null: 'delete' },
    leftSeconds: { spec: { k: 'num', min: 0, max: 7200, int: true }, null: 'delete' },
    rightSeconds: { spec: { k: 'num', min: 0, max: 7200, int: true }, null: 'delete' },
    feedingSessionId: optShort(),
  },
  pumping: { expressedMl: { spec: { k: 'num', min: 0, max: 500 }, null: 'delete' } },
  diaper: {
    urine: { spec: { k: 'enum', values: YNU } },
    stool: { spec: { k: 'enum', values: YNU } },
    changed: { spec: { k: 'bool' } },
    stoolNote: optShort(),
  },
  sleep_start: { sessionId: { spec: { k: 'id' } } },
  sleep_end: { sessionId: { spec: { k: 'id' } }, startEventId: { spec: { k: 'id' } } },
  bath: { bathingMode: { spec: { k: 'enum', values: ['sponge', 'tub'] }, null: 'delete' } },
  vomit: {
    amountCategory: { spec: { k: 'enum', values: ['small', 'medium', 'large', 'unknown'] }, null: 'delete' },
    appearanceText: optShort(),
    contextTags: tags,
  },
  temperature: {
    celsius: { spec: { k: 'num', min: 30, max: 45 } },
    measurementMethod: { spec: { k: 'enum', values: ['axillary', 'ear', 'forehead', 'rectal', 'other'] }, null: 'delete' },
  },
  symptom: { symptomTags: { spec: { k: 'strArr', maxItems: 20, itemMax: 50 } }, observedText: optText() },
  growth: {
    heightCm: { spec: { k: 'num', min: 20, max: 150 }, null: 'delete' },
    weightGrams: { spec: { k: 'num', min: 300, max: 50000 }, null: 'delete' },
    measurementPlace: optShort(),
  },
  meal: { text: optText(), tags },
  milestone: { text: optText(), tags },
  memo: { text: optText(), tags },
};

const PAYLOAD_REQUIRED: Record<string, string[]> = {
  feeding: ['method'],
  diaper: ['urine', 'stool', 'changed'],
  sleep_start: ['sessionId'],
  sleep_end: ['sessionId', 'startEventId'],
  temperature: ['celsius'],
  symptom: ['symptomTags'],
};

/** パッチ（部分）の検証。null は該当キー削除。 */
export function validatePayloadPatch(type: string, patch: unknown): Validated {
  const fields = PAYLOAD_FIELDS[type];
  if (!fields) throw new ApiError('failed-precondition', 'Payload of this event type cannot be edited');
  if (type === 'sleep_start' || type === 'sleep_end') {
    // セッション紐付けは訂正で変更しない（関連付けは別途）
    if (isPlainObject(patch) && Object.keys(patch).length > 0) bad('payload');
  }
  return validateObject(fields, patch, { label: 'payload' });
}

/** マージ後の payload 全体が型ごとの必須条件を満たすか確認する。 */
export function assertPayloadComplete(type: string, payload: Record<string, unknown>): void {
  for (const r of PAYLOAD_REQUIRED[type] ?? []) {
    if (payload[r] === undefined || payload[r] === null) bad(`payload.${r}`);
  }
  if (type === 'growth' && payload.heightCm === undefined && payload.weightGrams === undefined) bad('payload');
}

/** payload 全体（新規相当）の検証。 */
export function validateFullPayload(type: string, payload: unknown): Record<string, unknown> {
  const fields = PAYLOAD_FIELDS[type];
  if (!fields) return bad('payload');
  const v = validateObject(fields, payload, { label: 'payload' });
  assertPayloadComplete(type, v.set);
  return v.set;
}

export const EVENT_PATCH_FIELDS: Record<string, Field> = {
  occurredAt: { spec: { k: 'iso' } },
  endedAt: { spec: { k: 'iso' }, null: 'delete' },
  caregiverUid: { spec: { k: 'uid' }, null: 'store' },
  payload: { spec: { k: 'id' } }, // 実体は validatePayloadPatch で別途検証（ここではキー許可のみ）
  note: { spec: { k: 'text' }, null: 'delete' },
  contextEventIds: { spec: { k: 'strArr', maxItems: 20, itemMax: 128 } },
};

/** updateEvent の patch を検証する。payload は呼び出し側で type を見て検証する。 */
export function validateEventPatch(patch: unknown): { v: Validated; payloadPatch?: unknown } {
  if (!isPlainObject(patch)) return bad('patch');
  const { payload, ...rest } = patch as Record<string, unknown>;
  const fields = { ...EVENT_PATCH_FIELDS };
  delete fields.payload;
  const v = validateObject(fields, rest, { label: 'patch' });
  if (payload !== undefined && !isPlainObject(payload)) bad('patch.payload');
  if (Object.keys(v.set).length === 0 && v.del.length === 0 && payload === undefined) bad('patch');
  if (v.set.contextEventIds) {
    const ids = v.set.contextEventIds as string[];
    if (!ids.every(isValidId)) bad('patch.contextEventIds');
  }
  return { v, payloadPatch: payload };
}

// ---------- updateDoc の kind 別定義 ----------
export type DocKind =
  | 'child' | 'healthProfile' | 'medication' | 'medicalVisit' | 'vaccination'
  | 'schedule' | 'task' | 'shopping' | 'handover' | 'contact';
export const DOC_KINDS: readonly DocKind[] = [
  'child', 'healthProfile', 'medication', 'medicalVisit', 'vaccination',
  'schedule', 'task', 'shopping', 'handover', 'contact',
];
export const DELETABLE_KINDS: readonly DocKind[] = ['schedule', 'task', 'shopping', 'handover', 'contact'];

export interface KindDef {
  needsChild: boolean;
  fields: Record<string, Field>;
  /** マージ後ドキュメントの整合性検査 */
  check?: (merged: Record<string, unknown>) => void;
}

const dateStore = (): Field => ({ spec: { k: 'date' }, null: 'store' });
const dateDel = (): Field => ({ spec: { k: 'date' }, null: 'delete' });
const refsField = (): Field => ({ spec: { k: 'refs' } });

export const KIND_DEFS: Record<DocKind, KindDef> = {
  child: {
    needsChild: false, // docId が childId
    fields: {
      nickname: { spec: { k: 'str' } },
      birthDate: dateStore(),
      dueDate: dateStore(),
      enabledRecordTypes: { spec: { k: 'enumArr', values: EVENT_TYPES } },
    },
  },
  healthProfile: {
    needsChild: true,
    fields: {
      allergies: { spec: { k: 'allergies' } },
      conditionsNote: optText(),
      primaryClinic: { spec: { k: 'clinic' }, null: 'delete' },
    },
  },
  medication: {
    needsChild: true,
    fields: {
      name: { spec: { k: 'str' } },
      instructionText: { spec: { k: 'text' } },
      amount: { spec: { k: 'num', min: 0, max: 100000 }, null: 'delete' },
      unit: { spec: { k: 'str', max: 20 }, null: 'delete' },
      instructionSource: { spec: { k: 'str' } },
      startDate: dateDel(),
      endDate: dateDel(),
      asNeeded: { spec: { k: 'bool' } },
      status: { spec: { k: 'enum', values: ['active', 'ended'] } },
    },
  },
  medicalVisit: {
    needsChild: true,
    fields: {
      occurredOn: { spec: { k: 'date' } },
      provider: { spec: { k: 'str' } },
      reason: { spec: { k: 'text' } },
      observations: optText(),
      questions: optText(),
      clinicianInstructions: optText(),
      nextAction: optText(),
      scheduleId: { spec: { k: 'id' }, null: 'store' },
    },
  },
  vaccination: {
    needsChild: true,
    fields: {
      name: { spec: { k: 'str' } },
      doseLabel: { spec: { k: 'str', min: 0, max: 100 } },
      status: { spec: { k: 'enum', values: ['planned', 'reserved', 'administered', 'cancelled'] } },
      scheduledDate: dateStore(),
      administeredDate: dateStore(),
      provider: optShort(),
      scheduleId: { spec: { k: 'id' }, null: 'store' },
      source: optShort(),
      kind: { spec: { k: 'enum', values: ['vaccination', 'checkup'] } },
    },
  },
  schedule: {
    needsChild: false,
    fields: {
      title: { spec: { k: 'str' } },
      category: { spec: { k: 'enum', values: ['medical', 'procedure', 'other'] } },
      childId: { spec: { k: 'id' }, null: 'store' },
      allDay: { spec: { k: 'bool' } },
      date: dateDel(),
      startAt: { spec: { k: 'iso' }, null: 'delete' },
      endAt: { spec: { k: 'iso' }, null: 'delete' },
      location: optShort(),
      timezone: { spec: { k: 'str', max: 64 } },
      assigneeUids: { spec: { k: 'uidArr' } },
      status: { spec: { k: 'enum', values: ['planned', 'done', 'cancelled'] } },
      relatedRefs: refsField(),
      preparation: optText(),
    },
    check: (m) => {
      if (m.allDay === true) {
        if (typeof m.date !== 'string') bad('date');
      } else {
        if (!m.startAt) bad('startAt');
        const s = m.startAt as Timestamp;
        const e = m.endAt as Timestamp | undefined;
        if (e && e.toMillis() < s.toMillis()) bad('endAt');
      }
    },
  },
  task: {
    needsChild: false,
    fields: {
      title: { spec: { k: 'str' } },
      category: { spec: { k: 'enum', values: ['procedure', 'household', 'medical', 'other'] } },
      assigneeUid: { spec: { k: 'uid' }, null: 'store' },
      status: { spec: { k: 'enum', values: ['todo', 'doing', 'done'] } },
      dueDate: dateStore(),
      deadlineBasis: optShort(),
      deadlineVerified: { spec: { k: 'bool' } },
      sourceUrl: { spec: { k: 'url' }, null: 'delete' },
      sourceCheckedAt: dateStore(),
      step: optText(),
      relatedRefs: refsField(),
    },
  },
  shopping: {
    needsChild: false,
    fields: {
      name: { spec: { k: 'str' } },
      brand: optShort(),
      size: optShort(),
      quantity: { spec: { k: 'num', min: 0, max: 10000, int: true }, null: 'store' },
      assigneeUid: { spec: { k: 'uid' }, null: 'store' },
      status: { spec: { k: 'enum', values: ['needed', 'purchased'] } },
    },
  },
  handover: {
    needsChild: false,
    fields: {
      text: { spec: { k: 'str', max: TEXT_MAX } },
      priority: { spec: { k: 'enum', values: ['normal', 'important'] } },
      recipientUids: { spec: { k: 'uidArr' } },
      expiresAt: { spec: { k: 'iso' }, null: 'store' },
      relatedRefs: refsField(),
      status: { spec: { k: 'enum', values: ['open', 'resolved'] } },
    },
  },
  contact: {
    needsChild: false,
    fields: {
      name: { spec: { k: 'str' } },
      phone: { spec: { k: 'str', max: 50 }, null: 'delete' },
      url: { spec: { k: 'url' }, null: 'delete' },
      category: { spec: { k: 'enum', values: ['clinic', 'municipality', 'consultation', 'other'] } },
      note: optText(),
    },
  },
};

/** updateDoc の patch を検証。空 patch は拒否。 */
export function validateDocPatch(kind: DocKind, patch: unknown): Validated {
  const def = KIND_DEFS[kind];
  const v = validateObject(def.fields, patch, { label: 'patch' });
  if (Object.keys(v.set).length === 0 && v.del.length === 0) bad('patch');
  return v;
}

/** kind とパスの解決。child 系は childId 必須。 */
export function resolveDocPath(kind: DocKind, familyId: string, childId: string | undefined, docId: string): string {
  const base = `families/${familyId}`;
  const def = KIND_DEFS[kind];
  if (kind === 'child') {
    if (childId !== undefined && childId !== docId) bad('childId');
    return `${base}/children/${docId}`;
  }
  if (def.needsChild) {
    if (!childId) bad('childId');
    const c = `${base}/children/${childId}`;
    switch (kind) {
      case 'healthProfile': return `${c}/healthProfiles/${docId}`;
      case 'medication': return `${c}/medications/${docId}`;
      case 'medicalVisit': return `${c}/medicalVisits/${docId}`;
      case 'vaccination': return `${c}/vaccinations/${docId}`;
    }
  }
  switch (kind) {
    case 'schedule': return `${base}/schedules/${docId}`;
    case 'task': return `${base}/tasks/${docId}`;
    case 'shopping': return `${base}/shopping/${docId}`;
    case 'handover': return `${base}/handovers/${docId}`;
    case 'contact': return `${base}/contacts/${docId}`;
  }
  return bad('kind');
}
