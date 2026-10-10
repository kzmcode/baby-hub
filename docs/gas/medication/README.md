# medication（投薬の予定・担当・完了）

実装: `gas/medication/index.ts`。移植元 `functions/src/doses.ts`。

## 提供関数

| fn | 入力 | 出力 | 主なエラー（details） |
| --- | --- | --- | --- |
| `createDoseOccurrence` | `{ familyId, childId, medicationId, plannedAt? }` | `{ occurrenceId }` | `not-found`, `failed-precondition`（薬が active でない）。同じ `(medicationId, plannedAt)` の未完了（planned / claimed）があればそれを返す（重複防止）。30 回/時の回数制限 |
| `claimDose` | `{ familyId, childId, occurrenceId }` | `{ state: 'claimed', claimedBy }` | `failed-precondition`（`{ claimedBy }` 他者が担当済み / `{ state }` 担当不可の状態） |
| `releaseDose` | 同上 | `{ ok: true }` | `permission-denied`（`{ claimedBy }`）, `failed-precondition` |
| `completeDose` | `{ familyId, childId, occurrenceId, eventId, occurredAt, amount?, unit?, note? }` | `{ eventId, alreadyCompleted }` | `already-exists`（eventId 使用済み）, `not-found`（薬が無い）, `failed-precondition`（薬が active でない）, `invalid-argument`（`occurredAt` が現在 + 10 分より未来） |
| `skipDose` | `{ familyId, childId, occurrenceId, reason? }` | `{ ok: true }` | `failed-precondition` |

- すべて Firestore トランザクションで状態遷移を検証（二重服薬防止）。`completeDose` は冪等（完了済みなら既存 eventId を返す）で、`medication_taken` イベントを同一トランザクションで作成する。

- `documents/setEventStatus` で `medication_taken` を `void` にすると、対応する occurrence を同一トランザクションで `completed` → `planned`（`completedEventId=null`, `claimedBy=null`）に戻す。`active` に戻すと再び `completed`（occurrence が既に別の event で完了／skipped 等なら `failed-precondition`, `details.reason='occurrence-unavailable'`）。`updateEvent` は `medication_taken` の `note` 以外（`occurredAt` / `caregiverUid` など）を拒否し、`void` の event は編集不可（`failed-precondition`）。

## 必要な設定

特別な設定なし。

## Web からの呼び出し

`api.createDoseOccurrence(...)`, `api.claimDose(...)`, `api.releaseDose(...)`, `api.completeDose(...)`, `api.skipDose(...)`。

## 動作確認

2 ユーザーで同じ occurrence を `claimDose` → 後者が `failed-precondition`（details.claimedBy）。`completeDose` を 2 回呼び 2 回目が `alreadyCompleted: true`。

## 制約・注意

- GAS の応答遅延（1〜数秒）のため、Web は楽観表示せず結果で状態を更新すること。
