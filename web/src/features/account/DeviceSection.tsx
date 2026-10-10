import { useState } from 'react';
import { clearLocalData, enableTrustedDeviceCache, isTrustedDevice } from '../../lib/firebase';
import { useSyncStatus } from '../../lib/sync';
import { useAuth } from '../../context';
import { Button, Card, useToast } from '../../components';
import { releaseDeviceRegistration } from '../../lib/device';
import { SubPage } from './SubPage';

export const PROVIDER_LABEL: Record<string, string> = { 'google.com': 'Google', password: 'メールアドレスとパスワード', 'apple.com': 'Apple' };

export function DeviceSection() {
  const { user } = useAuth();
  const sync = useSyncStatus();
  const toast = useToast();
  const [trusted] = useState(isTrustedDevice());
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !trusted;
    const msg = next
      ? 'この端末を信頼端末にしますか？ 記録がこの端末に保存され、オフラインでも記録・閲覧できます。自分専用の端末だけで有効にしてください。'
      : 'オフライン保存をやめますか？ 未同期の記録がある場合は先に通信できる状態で同期してください。';
    if (next === false && sync.pendingWrites && !window.confirm('未同期の記録があります。この端末だけに残っている記録が失われる可能性があります。続けますか？')) return;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      if (!next) await releaseDeviceRegistration(user?.uid); // 共有端末では通知を使わないため、先に登録を解除
      await enableTrustedDeviceCache(next);
      if (!next) await clearLocalData();
      window.location.reload();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '端末の設定変更に失敗しました。');
      setBusy(false);
    }
  }
  async function clear() {
    if (!window.confirm((sync.pendingWrites ? '未同期の記録があります。消去すると失われる可能性があります。\n' : '') + 'この端末に保存されたキャッシュを消去しますか？ ログインは維持され、データは再取得されます。この端末の通知登録も解除されるため、通知は再度有効にしてください。')) return;
    setBusy(true);
    try { await releaseDeviceRegistration(user?.uid); await clearLocalData(); } catch (e) {
      toast.show(e instanceof Error ? e.message : '消去に失敗しました。');
      setBusy(false);
      return;
    }
    toast.show('端末のキャッシュを消去しました。通知は設定から再度有効にしてください。再読み込みします。', { duration: 2000 });
    setTimeout(() => window.location.reload(), 600);
  }

  return (
    <SubPage title="この端末">
      <Card className="stack">
        <h2>オフライン保存（信頼端末）</h2>
        <p>現在: <strong>{trusted ? '信頼端末（オフライン保存あり）' : '共有端末として使用（保存しない）'}</strong></p>
        <p className="small muted">自分専用の端末だけで有効にしてください。有効にすると、通信できなくても記録でき、あとで自動的に同期されます。無効のときは記録を永続保存せず、タブを閉じるとログイン状態も終了します。</p>
        <Button loading={busy} onClick={toggle}>{trusted ? 'オフライン保存をやめる' : 'この端末を信頼端末にする'}</Button>
      </Card>
      <Card className="stack">
        <h2>同期の状態</h2>
        <p>{sync.online ? 'オンライン' : 'オフライン'}・{sync.pendingWrites ? '未同期の記録があります' : '未同期の記録はありません'}</p>
        <p className="small muted">端末の OS のストレージ削除やアプリの削除で、未同期の記録は失われることがあります。</p>
        <Button variant="danger" loading={busy} onClick={clear}>端末のキャッシュを消去</Button>
      </Card>
      <Card className="stack">
        <h2>現在のログイン方法</h2>
        <ul className="acc-list">
          {(user?.providerData ?? []).map((p) => (
            <li key={p.providerId}>{PROVIDER_LABEL[p.providerId] ?? p.providerId}<span className="small muted">{p.email ?? ''}</span></li>
          ))}
        </ul>
        <p className="small muted">別の方法で新しくアカウントを作ると、データが空に見えます。以前の方法でログインし直してください。</p>
      </Card>
    </SubPage>
  );
}
