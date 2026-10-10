import { useState } from 'react';
import { sendEmailVerification } from 'firebase/auth';
import { api } from '../../lib/api';
import { clearLocalData } from '../../lib/firebase';
import { useAuth, useFamily } from '../../context';
import { Button, Card, useToast } from '../../components';
import { authErrorMessage } from './logic/errors';
import { DangerFlow } from './ReauthFlow';
import { cleanupDeviceRegistration } from './util';
import { SubPage } from './SubPage';

export function AccountSection() {
  const { user, signOut } = useAuth();
  const { familyId, family, role, activeMembers } = useFamily();
  const toast = useToast();
  const [flow, setFlow] = useState<'family' | 'account' | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = role === 'owner';
  const others = activeMembers.filter((m) => m.uid !== user?.uid);
  const soleMember = activeMembers.length <= 1;
  const isPasswordUser = !!user?.providerData.some((p) => p.providerId === 'password');

  async function logout() {
    if (!window.confirm('ログアウトしますか？ この端末のキャッシュと通知の登録も整理されます。未同期の記録は失われる可能性があります。')) return;
    setBusy(true);
    await signOut();
  }
  async function resendVerify() {
    if (!user) return;
    try { await sendEmailVerification(user); toast.show('確認メールを送信しました。'); } catch (e) { toast.show(authErrorMessage(e), { tone: 'error' }); }
  }

  return (
    <SubPage title="アカウント・削除">
      <Card className="stack">
        <h2>ログイン中</h2>
        <p>{user?.email ?? user?.displayName}</p>
        {isPasswordUser && !user?.emailVerified && (
          <>
            <p className="small acc-err">メールアドレスが未確認です。</p>
            <Button onClick={resendVerify}>確認メールを再送</Button>
          </>
        )}
        <Button loading={busy} onClick={logout}>ログアウト</Button>
      </Card>

      <Card className="stack">
        <h2>家族データの削除{!isOwner && '（管理者のみ）'}</h2>
        <p className="small">家族全体（子ども、すべての記録、予定、ToDo、健康情報、招待、通知）を削除します。<strong>元に戻せません。</strong>両方のメンバーがこの家族を使えなくなります。必要なら先に「データ出力」を行ってください。運用上のバックアップは14日間保持され、期限後の定期処理で完全削除されます。定期処理が停止した場合は、再開後に削除されます。</p>
        <Button variant="danger" disabled={!isOwner || !familyId} onClick={() => setFlow('family')}>家族データを削除する</Button>
      </Card>

      <Card className="stack">
        <h2>アカウントの削除</h2>
        <p className="small">ログインアカウント、あなたの設定、端末の通知登録、家族への所属を削除します。</p>
        <ul className="small">
          <li>家族に他のメンバーがいる場合: 子どもの共同記録は家族に残り、あなたの記録者表示は「退出したメンバー」になります。</li>
          <li>あなたが管理者で他のメンバーがいる場合: 先に管理者を移譲してください（削除できません）。</li>
          {soleMember && familyId && <li className="acc-err"><strong>あなたが唯一のメンバーのため、家族のデータもすべて削除されます。</strong></li>}
        </ul>
        {isOwner && others.length > 0 && <p className="small acc-err">先に「家族」画面で管理者を移譲してください。</p>}
        <Button variant="danger" disabled={isOwner && others.length > 0} onClick={() => setFlow('account')}>アカウントを削除する</Button>
      </Card>

      <DangerFlow open={flow === 'family'} onClose={() => setFlow(null)} title="家族データの削除" confirmText={family?.name} actionLabel="本人確認して削除"
        run={async () => {
          await api.deleteFamily({ familyId: familyId!, confirmName: family!.name });
          await clearLocalData();
          window.location.replace('/');
        }}>
        <p>「{family?.name}」のすべてのデータを削除します。元に戻せません。</p>
      </DangerFlow>

      <DangerFlow open={flow === 'account'} onClose={() => setFlow(null)} title="アカウントの削除" actionLabel="本人確認して削除"
        run={async () => {
          // 認証が有効なうちに FCM トークン・devices・SW を整理（削除後は Rules で消せないため）
          await cleanupDeviceRegistration(user?.uid);
          await api.deleteAccount();
          await signOut({ skipCleanup: true });
        }}>
        <p>アカウントを削除します。元に戻せません。</p>
        {soleMember && familyId
          ? <p className="acc-err"><strong>あなたは唯一のメンバーのため、家族「{family?.name}」のデータもすべて削除されます。</strong></p>
          : <p className="small">家族の共同記録は残り、あなたの記録者表示は「退出したメンバー」になります。</p>}
      </DangerFlow>
    </SubPage>
  );
}
