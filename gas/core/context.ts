import type { Firestore } from './firestore';
import { createFirestore } from './firestore';
import type { Platform } from './platform/types';

export interface CallContext {
  uid: string;
  authTime: number; // epoch sec
  email?: string;
  signInProvider?: string;
  platform: Platform;
  db: Firestore;
  now(): Date;
}
export type Handler = (ctx: CallContext, data: any) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

let currentPlatform: Platform | undefined;
const dbs = new WeakMap<Platform, Firestore>();

/** エントリポイント（doPost・トリガー・dev-server）が最初に呼ぶ */
export function setPlatform(p: Platform): void {
  currentPlatform = p;
}
export function getPlatform(): Platform {
  if (!currentPlatform) throw new Error('Platform is not initialized');
  return currentPlatform;
}
export function getDb(): Firestore {
  return dbFor(getPlatform());
}
export function dbFor(p: Platform): Firestore {
  let db = dbs.get(p);
  if (!db) {
    db = createFirestore(p);
    dbs.set(p, db);
  }
  return db;
}
