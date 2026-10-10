# 通知（gas/notify）

Cloud Functions の `onHandoverCreated` / `onScheduleWritten` / `dispatchNotifications` / `registerDevice` / `sendTestNotification` を GAS へ移植したもの。Firestore トリガーが無いため、**Web からの即時呼び出し**と **5分毎トリガー**の組み合わせで動く。

## 提供する関数（Web から `fn` で呼ぶ）

| fn | 入力 | 出力 | 概要 |
| --- | --- | --- | --- |
| `registerDevice` | `{ deviceId, fcmToken, platform }` | `{ ok: true }` | `users/{uid}/devices/{deviceId}` に保存（新規は `trusted:false, pushEnabled:true`）。`platform` は `ios\|android\|desktop\|other`（未知は `other`）。同じ `fcmToken` を持つ**他の自端末ドキュメントは削除**（重複排除）。同じ `fcmToken` を持つ**他 uid** の端末登録は、逆引き文書 `system/deviceTokens/tokens/{sha256(token)}`（`{uid, deviceId, updatedAt}`、Rules 既定拒否）で検出して削除する（トランザクション外で検出し、collectionGroup は使わない）。逆引き文書は registerDevice（置き換え・上限超過で消える古いトークン分も整理）、無効トークンの削除、アカウント削除で整合を保ち、端末のクライアント削除などで古くなっても次の登録時に実在を確認して自己修復する。端末は 1 uid あたり最大 10 台（超過時は `updatedAt` が最古のものを削除）。10 回/時の回数制限あり |
| `sendTestNotification` | `{}` | `{ sent }` | 本人の端末へ「テスト通知です」を送る |
| `notifyHandoverCreated` | `{ familyId, handoverId }` | `{ queued, sent }` | 呼出者が申し送りの作成者であること・家族メンバーであることを検査。宛先（`recipientUids`、空なら作成者以外の有効メンバー全員）ごとにジョブ `handover_{handoverId}_r{revision}_{uid}` を作成（既存ならスキップ＝冪等）し、その場で送信を試みる |
| `syncScheduleReminder` | `{ familyId, scheduleId }` | `{ action: 'created'\|'updated'\|'cancelled'\|'none' }` | 時刻付き・planned・未来の予定について、開始60分前のジョブ `schedule_{scheduleId}_{dueMs}_{uid}` を作成。時刻変更・取消し・削除で不要になった pending ジョブは `skipped(schedule-changed)` にする |

通知ジョブの種別に `ownerTransfer` を追加（`relatedKind: 'family'`, `relatedId: familyId`）。`family/transferOwnership` が `enqueueOwnerTransferNotice(db, platform, familyId, toUid, proposedAtMs)` で作成して即時送信を試みる（本文は定型文「管理者の移譲が提案されています」、url `/more/family`）。提案が取消し・承認・期限切れ・宛先違いになった場合、ジョブは `skipped(related-closed / expired)` になる。

内部関数（G2 が `updateDoc` / `deleteDoc` から import して呼ぶ）: `syncScheduleReminderInternal(db, familyId, scheduleId)` と `cancelScheduleReminderInternal(db, familyId, scheduleId)`。

## 流れ

1. **即時**: Web が申し送り作成後に `notifyHandoverCreated`。ジョブを作成し、受信者の `settings.notify` と静穏時間（Asia/Tokyo、既定 22:00〜07:00）を確認。静穏時間外なら同じリクエスト内で FCM 送信。静穏時間中の通常申し送りは `dueAt` を静穏終了時刻へ延期。**important は静穏時間でも送る**（functions 版と同じ）。
2. **5分毎トリガー `dispatchNotifications`** → `runDispatch()`:
   - スイープ（約10分に1回）: 全 active family を列挙し（collectionGroup 不使用）、過去24時間に作成された open な申し送り（初版のみ）のジョブ欠落と、今後3時間以内に始まる planned な予定のリマインダ欠落を補完。
   - `dueAt <= now` の pending ジョブを最大100件処理（lease 4分、attempts ≤ 3、再試行は5分後）。時間予算は約4.5分で、超えたら次回へ持ち越す。
   - 戻り値 `{ sent, skipped, failed, deferred, swept }` をログに出す。
3. 送信前に家族・メンバー（退出済みには送らない）・関連項目（申し送りが open か／予定が変わっていないか）を再確認する。
4. 文言は定型文のみ（「重要な申し送りがあります」「確認したい申し送りがあります」「近づいている予定があります」）。data は `{ type, url, jobId }`。子ども名・自由文・薬名は載せない。ログにもトークンや本文は出さない。
5. 5分毎の実行では、約 6 時間に 1 回、前日以前の日次カウンタ（プロパティ `rld:*`）と 7 日以上残ったアカウント削除ロックも後始末する（[account](../account/README.md)）。
6. FCM が `UNREGISTERED` / `INVALID_ARGUMENT`（HTTP 404 `NOT_FOUND` を含む）を返した端末は `devices` から削除する。

## 初期設定（FCM）

1. Firebase Console > プロジェクトの設定 > **Cloud Messaging** で **Firebase Cloud Messaging API (V1)** が有効であることを確認（GCP の API ライブラリで "Firebase Cloud Messaging API" を有効化）。
2. 同じ画面の **ウェブプッシュ証明書**で VAPID 鍵ペアを生成し、公開鍵を Web の `VITE_FIREBASE_VAPID_KEY` に設定（Web 担当）。
3. GAS プロジェクトを **標準の GCP プロジェクト（Firebase と同じ）に紐付ける**（Apps Script > プロジェクトの設定 > Google Cloud Platform プロジェクト）。`ScriptApp.getOAuthToken()` のトークンで FCM v1 を呼ぶため。
4. `appsscript.json` の `oauthScopes` に `https://www.googleapis.com/auth/firebase.messaging`（ほか `script.external_request`、`datastore`）を含める。初回はスクリプトエディタから関数を1回実行して承認する。
5. スクリプトプロパティ `FIREBASE_PROJECT_ID` を設定（FCM の宛先プロジェクト、通知クリック先 `https://{projectId}.web.app{url}` にも使う。カスタムドメインを使う場合は `gas/notify/fcm.ts` の `linkFor` を調整）。
6. トリガー: `setupTriggers()` が `dispatchNotifications` を5分毎に登録する。
7. `config.fcmEnabled=false` またはエミュレータでは FCM を呼ばず、ログに記録して成功扱いにする。

## iPhone / ブラウザ

iPhone・iPad は **iOS/iPadOS 16.4 以降で、Safari から「ホーム画面に追加」した PWA** でのみ Web Push が届く。通知許可はアプリ内のボタン操作から要求する。通知は補助であり、到達や時刻は保証されない（集中モード等も解除できない）。非対応・不許可でもアプリ内の表示は使える。

## 動作確認

1. 設定画面で通知を許可 → `registerDevice` で端末登録 → 「テスト通知」（`sendTestNotification`）で `sent: 1`。
2. 2アカウントで重要な申し送りを作成 → 相手端末に即時通知。通常の申し送りは受信者が「通常の申し送り」を ON にしている場合のみ。
3. 22:00〜07:00 に通常申し送りを作ると `notificationJobs.dueAt` が翌 07:00 になる。
4. 予定を開始90分後で作成 → `syncScheduleReminder` → 30分後に `dueAt` のジョブができ、5分毎トリガーで送信される。
5. Web の呼び出しを止めて申し送りを作成（Firestore 直書き）→ 最大約10分後のスイープでジョブが補完される。

## 実行時間・クォータの目安

- 5分毎 = 288回/日。空振りの1回は 数秒（Firestore 読取は families 1 + 各家族2クエリ + pending クエリ 1 程度）。仮に平均 3 秒なら **約15分/日**。GAS の無料アカウント（consumer）のトリガー合計実行時間は **90分/日**、1実行は最大6分、UrlFetch は 2万回/日。ジョブが多い日は 1通あたり FCM 1回 + Firestore 数回。
- Firestore（Spark）読取 5万/日に対し、通知処理は空振り時 1 実行あたり数読取（約 1,500〜3,000/日）が目安。スイープは約10分に1回に間引いている（CacheService の `notify.sweep`）。

## トラブルシュート

| 症状 | 確認 |
| --- | --- |
| `sent: 0`、`no-device` | 端末が未登録／`pushEnabled:false`。`registerDevice` が成功しているか |
| FCM が 401/403 | GCP 紐付け、`firebase.messaging` スコープの承認、FCM API (V1) の有効化。ジョブは `retry`（最大3回）後 `failed` |
| `no-valid-token` | トークン失効。端末側で再登録（削除済み） |
| ジョブが送られない | `dueAt` が未来、静穏時間、`user-disabled`（`resultNote` を確認）。トリガーが登録されているか |
| 実行時間エラー | 実行ログの `dispatch budget exceeded`。ジョブ滞留なら手動で `dispatchNotifications` を実行 |
| 複合インデックス | `notificationJobs` の `status + dueAt`、`handovers` の `createdAt` 単一範囲、`schedules` の `startAt` 範囲（自動の単一フィールドインデックスで足りる）。`notificationJobs` の `familyId + relatedId + status` は等価条件のみ |

## 制約

- 通知はベストエフォート。重複送信ゼロ・到達保証はない（lease とジョブIDで二重送信を抑える）。
- 申し送りを編集した場合の再通知はしない（スイープは revision 1 のみ補完、再通知は `notifyHandoverCreated` を作成者が明示的に呼んだ場合のみ）。
- 送信は端末ごとに1リクエスト（FCM v1 にマルチキャストが無いため）。端末が多い家族では UrlFetch が増える。
