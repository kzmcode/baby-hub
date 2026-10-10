// フォーム値 → Firestore 作成データ（createFamilyDoc）／updateDoc パッチ
import { Timestamp } from 'firebase/firestore';
import { combineDateTime, TZ } from '../../lib/time';
import type { HandoverValues, ScheduleValues, ShoppingValues, TaskValues } from './forms';
import { omitNull } from './types';

export function scheduleCreate(v: ScheduleValues): Record<string, unknown> {
  return omitNull({
    title: v.title, category: v.category, allDay: v.allDay,
    date: v.allDay ? v.date : null,
    startAt: v.startAt ? Timestamp.fromDate(v.startAt) : null,
    endAt: v.endAt ? Timestamp.fromDate(v.endAt) : null,
    location: v.location, preparation: v.preparation,
    timezone: TZ, assigneeUids: v.assigneeUids, status: 'planned', relatedRefs: [],
  });
}
export function schedulePatch(v: ScheduleValues): Record<string, unknown> {
  return {
    title: v.title, category: v.category, allDay: v.allDay,
    date: v.allDay ? v.date : null,
    startAt: v.startAt ? v.startAt.toISOString() : null,
    endAt: v.endAt ? v.endAt.toISOString() : null,
    location: v.location, preparation: v.preparation, assigneeUids: v.assigneeUids,
  };
}

export function taskCreate(v: TaskValues): Record<string, unknown> {
  return omitNull({ ...v, status: 'todo', relatedRefs: [] });
}
export function taskPatch(v: TaskValues): Record<string, unknown> {
  return { ...v };
}

export function shoppingCreate(v: ShoppingValues): Record<string, unknown> {
  return omitNull({ ...v, status: 'needed' });
}

const expiresIso = (d: string | null) => (d ? combineDateTime(d, '23:59').toISOString() : null);

export function handoverCreate(v: HandoverValues): Record<string, unknown> {
  return omitNull({
    text: v.text, priority: v.priority, recipientUids: v.recipientUids,
    expiresAt: v.expiresDate ? Timestamp.fromDate(combineDateTime(v.expiresDate, '23:59')) : null,
    relatedRefs: v.relatedRefs, status: 'open',
  });
}
export function handoverPatch(v: HandoverValues): Record<string, unknown> {
  return {
    text: v.text, priority: v.priority, recipientUids: v.recipientUids,
    expiresAt: expiresIso(v.expiresDate), relatedRefs: v.relatedRefs,
  };
}
