# documents（記録・各種ドキュメントの更新/削除）

実装: `gas/documents/index.ts`（楽観ロック共通処理: `gas/shared/helpers.ts` の `updateWithRevision`）。移植元 `functions/src/docs.ts`。入力検証は `gas/shared/validate.ts`（許可キー方式・長さ/型制限）。

## 提供関数

| fn | 入力 | 出力 | 主なエラー |
| --- | --- | --- | --- |
| `updateEvent` | `{ familyId, childId, eventId, expectedRevision, patch }` | `{ revision }` | `aborted`（revision 不一致。details: `{ currentRevision, current }`）, `invalid-argument`, `failed-precondition`（medication_taken の payload 編集不可）, `not-found` |
| `setEventStatus` | `{ familyId, childId, eventId, expectedRevision, status: 'active'\|'void' }` | `{ revision }` | `aborted`, `not-found` |
| `updateDoc` | `{ familyId, kind, childId?, docId, expectedRevision, patch }` | `{ revision }` | `aborted`, `invalid-argument`, `not-found` |
| `deleteDoc` | `{ familyId, kind, childId?, docId, expectedRevision }` | `{ ok: true }` | `aborted`, `failed-precondition`（削除不可 kind）, `not-found` |

- `kind: 'schedule'` の `updateDoc` 後に `syncScheduleReminderInternal(db, familyId, scheduleId)`、`deleteDoc` 後に `cancelScheduleReminderInternal(...)`（いずれも `gas/notify`）を呼ぶ。失敗してもログ（familyId/scheduleId のみ）を残して本処理は成功を返す。取りこぼしは 5 分毎のスイープで補完される。
- 参照の実在確認: `updateDoc` の `schedule.childId` / `relatedRefs[].childId` は同一家族内の子どもが実在すること、`updateEvent` の `contextEventIds` は同じ子どもの events に実在すること（`getAll` 1 回、不在は `invalid-argument`）。`void` の event は `updateEvent` 不可、`medication_taken` は `note` のみ変更可（[medication](../medication/README.md)）。
- `deleteDoc` で `kind: 'handover'` の場合、`acks` サブコレクションも `recursiveDelete` する。
- `deleteDoc` は削除と同じトランザクションで `deletions/{hash}`（パスと `deletedAt` のみ）を記録する。子文書単位の記録だが、21日経過後にバックアップの日次処理で自動清掃される（[バックアップ](../backup/README.md)）。

## 必要な設定

特別な設定なし。schedule のリマインダは notify 側の設定（FCM、`fcmEnabled`）に従う。

## Web からの呼び出し

`api.updateEvent(...)`, `api.setEventStatus(...)`, `api.updateDoc(...)`, `api.deleteDoc(...)`。`aborted` の `details.current` で競合画面を出す動作は functions 版と同じ。

## 動作確認

予定を作成 → `updateDoc`（kind=schedule, patch で開始時刻変更）→ `notificationJobs` に reminder ジョブが更新される。`deleteDoc` で pending ジョブが取り消される。古い `expectedRevision` を渡すと `aborted` が返る。

## 制約・注意

- 1 リクエストは 64KB まで（core）。`recursiveDelete` は acks が大量だと遅い（通常は数件）。
