// Firestore パス・購読フック・共通書き込みヘルパ
import { useEffect, useRef, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  queryEqual,
  refEqual,
  serverTimestamp,
  setDoc,
  Timestamp,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type Query,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import type { EventPayloadMap, EventType } from '../types/models';

/** コレクション／ドキュメント参照ヘルパ（パスは architecture.md 3章） */
export const paths = {
  user: (uid: string) => doc(db, 'users', uid),
  familyRefs: (uid: string) => collection(db, 'users', uid, 'familyRefs'),
  devices: (uid: string) => collection(db, 'users', uid, 'devices'),
  family: (fid: string) => doc(db, 'families', fid),
  members: (fid: string) => collection(db, 'families', fid, 'members'),
  children: (fid: string) => collection(db, 'families', fid, 'children'),
  child: (fid: string, cid: string) => doc(db, 'families', fid, 'children', cid),
  events: (fid: string, cid: string) => collection(db, 'families', fid, 'children', cid, 'events'),
  event: (fid: string, cid: string, eid: string) => doc(db, 'families', fid, 'children', cid, 'events', eid),
  healthProfile: (fid: string, cid: string) => doc(db, 'families', fid, 'children', cid, 'healthProfiles', 'main'),
  medications: (fid: string, cid: string) => collection(db, 'families', fid, 'children', cid, 'medications'),
  doseOccurrences: (fid: string, cid: string) => collection(db, 'families', fid, 'children', cid, 'doseOccurrences'),
  medicalVisits: (fid: string, cid: string) => collection(db, 'families', fid, 'children', cid, 'medicalVisits'),
  vaccinations: (fid: string, cid: string) => collection(db, 'families', fid, 'children', cid, 'vaccinations'),
  schedules: (fid: string) => collection(db, 'families', fid, 'schedules'),
  tasks: (fid: string) => collection(db, 'families', fid, 'tasks'),
  shopping: (fid: string) => collection(db, 'families', fid, 'shopping'),
  handovers: (fid: string) => collection(db, 'families', fid, 'handovers'),
  handover: (fid: string, hid: string) => doc(db, 'families', fid, 'handovers', hid),
  acks: (fid: string, hid: string) => collection(db, 'families', fid, 'handovers', hid, 'acks'),
  contacts: (fid: string) => collection(db, 'families', fid, 'contacts'),
  auditLogs: (fid: string) => collection(db, 'families', fid, 'auditLogs'),
} as const;

export type WithMeta<T> = T & { id: string; _pending: boolean };

export interface CollectionState<T> {
  data: WithMeta<T>[];
  loading: boolean;
  error: Error | null;
  fromCache: boolean;
}
export interface DocumentState<T> {
  data: WithMeta<T> | null;
  loading: boolean;
  error: Error | null;
  fromCache: boolean;
}

/** 毎レンダーで作り直されるクエリ／参照を、等価なら同一参照に安定化する（再購読の防止） */
function useStable<T extends Query | DocumentReference | null>(value: T): T {
  const ref = useRef<T>(value);
  const a = ref.current;
  if (a !== value) {
    const same =
      a && value
        ? 'type' in a && a.type === 'document'
          ? 'type' in value && value.type === 'document' && refEqual(a as DocumentReference, value as DocumentReference)
          : !('type' in value && value.type === 'document') && queryEqual(a as Query, value as Query)
        : false;
    if (!same) ref.current = value;
  }
  return ref.current;
}

/** クエリ購読。null なら購読せず空。メタ変更も受け取り _pending（未同期）を付与 */
export function useCollection<T = DocumentData>(q: Query | CollectionReference | null): CollectionState<T> {
  const stable = useStable(q as Query | null);
  const [state, setState] = useState<CollectionState<T>>({ data: [], loading: !!q, error: null, fromCache: false });
  useEffect(() => {
    if (!stable) {
      setState({ data: [], loading: false, error: null, fromCache: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      stable,
      { includeMetadataChanges: true },
      (snap) =>
        setState({
          data: snap.docs.map((d) => ({ ...(d.data() as T), id: d.id, _pending: d.metadata.hasPendingWrites })),
          loading: false,
          error: null,
          fromCache: snap.metadata.fromCache,
        }),
      (error) => setState((s) => ({ ...s, loading: false, error })),
    );
  }, [stable]);
  return state;
}

/** ドキュメント購読。null なら購読しない */
export function useDocument<T = DocumentData>(ref: DocumentReference | null): DocumentState<T> {
  const stable = useStable(ref);
  const [state, setState] = useState<DocumentState<T>>({ data: null, loading: !!ref, error: null, fromCache: false });
  useEffect(() => {
    if (!stable) {
      setState({ data: null, loading: false, error: null, fromCache: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      stable,
      { includeMetadataChanges: true },
      (snap) =>
        setState({
          data: snap.exists() ? { ...(snap.data() as T), id: snap.id, _pending: snap.metadata.hasPendingWrites } : null,
          loading: false,
          error: null,
          fromCache: snap.metadata.fromCache,
        }),
      (error) => setState((s) => ({ ...s, loading: false, error })),
    );
  }, [stable]);
  return state;
}

/** undefined を再帰的に除去（Firestore は undefined 不可、Rules は未知キー拒否） */
export function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripUndefined) as unknown as T;
  if (v && typeof v === 'object' && !(v instanceof Timestamp) && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = stripUndefined(val);
    return out as T;
  }
  return v;
}

function requireUid(): string {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('ログインが必要です');
  return uid;
}

export interface CreateEventInput<T extends EventType> {
  id?: string;
  type: T;
  occurredAt: Date;
  endedAt?: Date;
  /** 省略時はログイン中の本人。null は「実施者未確認」 */
  caregiverUid?: string | null;
  payload: EventPayloadMap[T];
  note?: string;
  sessionId?: string;
  // contextEventIds は作成時に送れない（Rules で禁止）。関連付けは api.updateEvent で行う
}

/**
 * イベント作成。setDoc を await せずローカルへ即反映（オフライン可）。
 * id は端末で生成（再試行でも同一）。promise はサーバー到達で解決。
 * recordedAt は端末時刻。保存時の「今」を使うため occurredAt の既定は呼び出し側で new Date() を渡す。
 */
export function createEvent<T extends EventType>(
  familyId: string,
  childId: string,
  input: CreateEventInput<T>,
): { id: string; promise: Promise<void> } {
  const uid = requireUid();
  const id = input.id ?? crypto.randomUUID();
  const data = stripUndefined({
    schemaVersion: 1,
    childId,
    type: input.type,
    occurredAt: Timestamp.fromDate(input.occurredAt),
    endedAt: input.endedAt ? Timestamp.fromDate(input.endedAt) : undefined,
    recordedAt: Timestamp.now(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: uid,
    updatedBy: uid,
    caregiverUid: input.caregiverUid === undefined ? uid : input.caregiverUid,
    sessionId: input.sessionId,
    payload: input.payload,
    note: input.note,
    revision: 1,
    status: 'active',
  });
  const promise = setDoc(paths.event(familyId, childId, id), data);
  promise.catch(() => undefined); // 呼び出し側が無視しても未処理拒否にしない
  return { id, promise };
}

/**
 * 予定・Task・買い物等の新規作成（オンライン確定）。
 * 共通フィールド（createdAt/updatedAt/createdBy/updatedBy/revision=1）を付与。status 等の初期値は data で渡す。
 * @param collectionPath 例: paths.tasks(familyId).path
 * @returns 新規ドキュメント ID
 */
export async function createFamilyDoc(collectionPath: string, data: Record<string, unknown>): Promise<string> {
  const uid = requireUid();
  const id = crypto.randomUUID();
  await setDoc(
    doc(db, collectionPath, id),
    stripUndefined({
      ...data,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: uid,
      updatedBy: uid,
      revision: 1,
    }),
  );
  return id;
}
