// 共通型（docs/architecture.md 3.2 と同一。functions/src/types.ts とも一致させる）
import type { Timestamp } from 'firebase/firestore';

export type Role = 'owner' | 'editor';
export type MemberStatus = 'active' | 'left' | 'removed';

export interface UserSettings {
  theme: 'system' | 'light' | 'dark';
  quietHours: { enabled: boolean; start: string /* "22:00" */; end: string /* "07:00" */ };
  notify: { handoverImportant: boolean; handoverNormal: boolean; scheduleReminder: boolean; taskDue: boolean; dose: boolean };
  homeItems: { key: HomeItemKey; visible: boolean }[];   // 並び順＝配列順
  quickRecordTypes: QuickRecordKey[];                       // 表示する記録ボタン
}
export type HomeItemKey = 'status' | 'quickRecord' | 'todayRhythm' | 'recent' | 'handovers' | 'todayPlans' | 'shopping';
export type QuickRecordKey = 'diaper' | 'feeding' | 'vomit' | 'sleep' | 'bath' | 'other';

export interface Family { name: string; timezone: string; ownerUid: string; status: 'active' | 'deleting'; createdAt: Timestamp; memberCount: number; pendingOwnerTransfer?: { toUid: string; proposedBy: string; proposedAt: Timestamp; expiresAt: Timestamp } | null; }
export interface Member { uid: string; role: Role; status: MemberStatus; joinedAt: Timestamp; displayName: string; }
export interface Child { nickname: string; birthDate: string | null /* yyyy-MM-dd */; dueDate: string | null; status: 'active'; enabledRecordTypes: EventType[]; isSample?: boolean; revision: number; createdAt: Timestamp; updatedAt: Timestamp; }

export type EventType = 'feeding' | 'pumping' | 'diaper' | 'sleep_start' | 'sleep_end' | 'bath' | 'vomit'
  | 'temperature' | 'symptom' | 'growth' | 'medication_taken' | 'meal' | 'milestone' | 'memo';

export type FeedingMethod = 'breast' | 'formula' | 'expressed_breast_milk';
export type YesNoUnknown = 'yes' | 'no' | 'unknown';

export interface EventPayloadMap {
  feeding: { method: FeedingMethod; consumedMl?: number; leftSeconds?: number; rightSeconds?: number; feedingSessionId?: string };
  pumping: { expressedMl?: number };
  diaper: { urine: YesNoUnknown; stool: YesNoUnknown; changed: boolean; stoolNote?: string };
  sleep_start: { sessionId: string };
  sleep_end: { sessionId: string; startEventId: string };
  bath: { bathingMode?: 'sponge' | 'tub' };           // 沐浴 / 入浴
  vomit: { amountCategory?: 'small' | 'medium' | 'large' | 'unknown'; appearanceText?: string; contextTags?: string[] };
  temperature: { celsius: number; measurementMethod?: 'axillary' | 'ear' | 'forehead' | 'rectal' | 'other' };
  symptom: { symptomTags: string[]; observedText?: string };
  growth: { heightCm?: number; weightGrams?: number; measurementPlace?: string };
  medication_taken: { medicationId: string; occurrenceId: string; amount?: number; unit?: string };
  meal: { text?: string; tags?: string[] };
  milestone: { text?: string; tags?: string[] };
  memo: { text?: string; tags?: string[] };            // 「その他・赤ちゃんの変化」
}

export interface DailyEvent<T extends EventType = EventType> {
  schemaVersion: 1;
  childId: string;
  type: T;
  occurredAt: Timestamp;
  endedAt?: Timestamp;
  recordedAt: Timestamp;        // 端末時刻
  createdAt: Timestamp; updatedAt: Timestamp;
  createdBy: string; updatedBy: string;
  caregiverUid?: string | null; // null/未設定＝実施者未確認
  sessionId?: string;           // sleep_start/sleep_end で payload.sessionId と同値
  sourceRef?: { kind: string; id: string };
  contextEventIds?: string[];
  payload: EventPayloadMap[T];
  note?: string;
  revision: number;
  status: 'active' | 'void';
}

export interface HealthProfile { allergies: { name: string; confirmation: 'confirmed_by_doctor' | 'suspected' | 'unconfirmed'; source?: string; note?: string }[]; conditionsNote?: string; primaryClinic?: { name: string; phone?: string; url?: string }; revision: number; }
export interface Medication { name: string; instructionText: string; amount?: number; unit?: string; instructionSource: string; startDate?: string; endDate?: string; asNeeded: boolean; status: 'active' | 'ended'; revision: number; }
export interface DoseOccurrence { medicationId: string; plannedAt?: Timestamp | null; state: 'planned' | 'claimed' | 'completed' | 'skipped' | 'cancelled'; claimedBy?: string | null; claimedAt?: Timestamp | null; completedEventId?: string | null; revision: number; }
export interface MedicalVisit { occurredOn: string; provider: string; reason: string; observations?: string; questions?: string; clinicianInstructions?: string; nextAction?: string; scheduleId?: string | null; revision: number; }
export interface Vaccination { name: string; doseLabel: string; status: 'planned' | 'reserved' | 'administered' | 'cancelled'; scheduledDate?: string | null; administeredDate?: string | null; provider?: string; scheduleId?: string | null; source?: string; kind: 'vaccination' | 'checkup'; revision: number; }

export type RelatedRef = { kind: 'event' | 'schedule' | 'task' | 'shopping' | 'handover' | 'medicalVisit' | 'vaccination' | 'medication'; id: string; childId?: string };
export interface Schedule { title: string; category: 'medical' | 'procedure' | 'other'; childId?: string | null; allDay: boolean; date?: string /* yyyy-MM-dd, allDay時 */; startAt?: Timestamp; endAt?: Timestamp; location?: string; timezone: string; assigneeUids: string[]; status: 'planned' | 'done' | 'cancelled'; relatedRefs: RelatedRef[]; preparation?: string; revision: number; }
export interface Task { title: string; category: 'procedure' | 'household' | 'medical' | 'other'; assigneeUid?: string | null; status: 'todo' | 'doing' | 'done'; dueDate?: string | null; deadlineBasis?: string; deadlineVerified: boolean; sourceUrl?: string; sourceCheckedAt?: string | null; step?: string; relatedRefs: RelatedRef[]; revision: number; }
export interface ShoppingItem { name: string; brand?: string; size?: string; quantity?: number | null; assigneeUid?: string | null; status: 'needed' | 'purchased'; revision: number; }
export interface Handover { text: string; priority: 'normal' | 'important'; recipientUids: string[]; expiresAt?: Timestamp | null; relatedRefs: RelatedRef[]; status: 'open' | 'resolved'; resolvedBy?: string | null; resolvedAt?: Timestamp | null; revision: number; }
export interface Ack { uid: string; acknowledgedAt: Timestamp; handoverRevision: number; }
export interface Contact { name: string; phone?: string; url?: string; category: 'clinic' | 'municipality' | 'consultation' | 'other'; note?: string; revision: number; }
export interface AuditLog { action: string; actorUid: string; target?: { kind: string; id: string }; at: Timestamp; }

// ---- 補助型（基盤担当が追加。既存型は変更していない） ----
export interface FamilyRef { familyId: string; role: Role; status: MemberStatus; joinedAt: Timestamp }
export interface UserDoc { displayName: string; createdAt: Timestamp; settings?: Partial<UserSettings> }
export interface DeviceDoc { fcmToken?: string; platform: string; trusted: boolean; pushEnabled: boolean; updatedAt: Timestamp }
/** 全ドキュメント共通の監査フィールド */
export interface Audit { createdAt: Timestamp; updatedAt: Timestamp; createdBy: string; updatedBy: string }
