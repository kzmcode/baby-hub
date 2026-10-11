import { useState } from 'react';
import { api, apiErrorMessage } from '../../lib/api';
import { getFcmToken, isTrustedDevice } from '../../lib/firebase';
import { useUserSettings } from '../../context';
import { Button, Card, Field, TextInput, useToast } from '../../components';
import type { UserSettings } from '../../types/models';
import { currentPlatform, getDeviceId } from '../../lib/device';
import { SHARED_DEVICE_NOTIFY_MESSAGE, canEnableNotifications } from '../../lib/startup';
import { SubPage } from './SubPage';

type Notify = UserSettings['notify'];
const NOTIFY_LABEL: Record<keyof Notify, string> = {
  handoverImportant: '重要な申し送り', handoverNormal: '通常の申し送り', scheduleReminder: '予定のリマインド（開始の約60分前）',
  taskDue: 'ToDo の期限', dose: '服薬の予定',
};

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export function NotificationSection() {
  const { settings, update } = useUserSettings();
  const toast = useToast();
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [busy, setBusy] = useState(false);
  const save = (p: Partial<UserSettings>) => update(p).catch(() => toast.show('保存できませんでした。', { tone: 'error' }));

  async function enable() {
    if (typeof Notification === 'undefined' || !canEnableNotifications(isTrustedDevice())) return;
    setBusy(true);
    try {
      const r = await Notification.requestPermission();
      setPerm(r);
      if (r !== 'granted') { toast.show('通知は許可されませんでした。端末の設定から変更できます。'); setBusy(false); return; }
      const token = await getFcmToken();
      if (!token) { toast.show('この環境ではプッシュ通知を利用できません。アプリ内通知は使えます。', { tone: 'error', duration: 8000 }); setBusy(false); return; }
      await api.registerDevice({ deviceId: getDeviceId(), fcmToken: token, platform: currentPlatform() });
      toast.show('この端末の通知を有効にしました。');
    } catch (e) { toast.show(apiErrorMessage(e), { tone: 'error' }); }
    setBusy(false);
  }
  async function test() {
    setBusy(true);
    try {
      const r = await api.sendTestNotification();
      toast.show(r.sent > 0 ? `テスト通知を ${r.sent} 台に送信しました。` : '送信先の端末がありません。先にこの端末の通知を有効にしてください。', { duration: 6000 });
    } catch (e) { toast.show(apiErrorMessage(e), { tone: 'error' }); }
    setBusy(false);
  }

  const shared = !canEnableNotifications(isTrustedDevice());
  const iosNeedsInstall = isIos() && !isStandalone();
  const q = settings.quietHours;

  return (
    <SubPage title="通知">
      <Card className="stack">
        <h2>通知の種類</h2>
        {(Object.keys(NOTIFY_LABEL) as (keyof Notify)[]).map((k) => (
          <label key={k} className="acc-check">
            <input type="checkbox" checked={settings.notify[k]} onChange={() => save({ notify: { ...settings.notify, [k]: !settings.notify[k] } })} />
            <span>{NOTIFY_LABEL[k]}</span>
          </label>
        ))}
        <p className="small muted">アプリ内の通知（ホームの未確認事項・予定・期限）は、通知を許可していない端末でも表示されます。プッシュ通知は補助で、到達や時刻は保証されません。通知を読んだだけで申し送りの確認や服薬の実施にはなりません。</p>
      </Card>

      <Card className="stack">
        <h2>静穏時間</h2>
        <label className="acc-check">
          <input type="checkbox" checked={q.enabled} onChange={() => save({ quietHours: { ...q, enabled: !q.enabled } })} />
          <span>静穏時間を使う（重要な申し送り以外は終了時刻まで保留）</span>
        </label>
        {q.enabled && (
          <div className="ch-pair">
            <Field label="開始">{(p) => <TextInput {...p} type="time" value={q.start} onChange={(e) => e.target.value && save({ quietHours: { ...q, start: e.target.value } })} />}</Field>
            <Field label="終了">{(p) => <TextInput {...p} type="time" value={q.end} onChange={(e) => e.target.value && save({ quietHours: { ...q, end: e.target.value } })} />}</Field>
          </div>
        )}
        <p className="small muted">OS の集中モードなどは解除できません。</p>
      </Card>

      <Card className="stack">
        <h2>この端末のプッシュ通知</h2>
        {iosNeedsInstall && (
          <Card tone="warning" className="small">iPhone / iPad では、Safari の共有メニューから「ホーム画面に追加」したアプリでのみプッシュ通知を受け取れます（iOS 16.4 以降）。ホーム画面のアイコンから開き直して設定してください。</Card>
        )}
        {shared && <Card tone="warning" className="small">{SHARED_DEVICE_NOTIFY_MESSAGE}。</Card>}
        <p>状態: {perm === 'granted' ? '許可済み' : perm === 'denied' ? '拒否（端末のブラウザ設定から変更）' : perm === 'default' ? '未設定' : 'この環境では非対応'}</p>
        <div className="row">
          <Button variant="primary" loading={busy} disabled={shared || perm === 'unsupported' || iosNeedsInstall || perm === 'denied'} onClick={enable}>
            {perm === 'granted' ? 'この端末の登録を更新' : 'この端末の通知を有効にする'}
          </Button>
          <Button disabled={busy || shared || perm !== 'granted'} onClick={test}>テスト通知を送る</Button>
        </div>
        <p className="small muted">ロック画面の通知には、子どもの名前・症状・薬名は表示されません。</p>
      </Card>
    </SubPage>
  );
}
