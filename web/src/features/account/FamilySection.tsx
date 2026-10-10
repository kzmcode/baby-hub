import { useState } from 'react';
import { api, apiErrorMessage } from '../../lib/api';
import { clearLocalData } from '../../lib/firebase';
import { useAuth, useFamily } from '../../context';
import { Button, Card, useToast } from '../../components';
import { buildInviteLink } from './logic/invite';
import { leaveErrorMessage } from './logic/errors';
import { transferErrorMessage, transferView } from './logic/transfer';
import { DangerFlow } from './ReauthFlow';
import { canShare, copyText, formatDateTimeJa, loadInvite, saveInvite, shareText, type StoredInvite } from './util';
import { SubPage } from './SubPage';

const ROLE: Record<string, string> = { owner: '管理者', editor: 'メンバー' };
const STATUS: Record<string, string> = { active: '参加中', left: '退出済み', removed: '削除済み' };

export function InvitePanel({ familyId }: { familyId: string }) {
  const toast = useToast();
  const [invite, setInvite] = useState<StoredInvite | null>(() => loadInvite());
  const [busy, setBusy] = useState(false);
  const link = invite ? buildInviteLink(window.location.origin, invite.token) : '';

  async function create() {
    setBusy(true);
    try {
      const inv = await api.createInvite({ familyId });
      saveInvite(inv); setInvite(inv);
      toast.show(invite ? '招待を再発行しました。以前の招待は使えなくなります。' : '招待を作成しました。');
    } catch (e) { toast.show(apiErrorMessage(e), { tone: 'error' }); }
    setBusy(false);
  }
  async function revoke() {
    if (!invite || !window.confirm('この招待を失効しますか？ 相手はこのリンクで参加できなくなります。')) return;
    setBusy(true);
    try {
      await api.revokeInvite({ familyId, inviteId: invite.inviteId });
      saveInvite(null); setInvite(null);
      toast.show('招待を失効しました。');
    } catch (e) { toast.show(apiErrorMessage(e), { tone: 'error' }); }
    setBusy(false);
  }
  async function copy(text: string, label: string) {
    toast.show((await copyText(text)) ? `${label}をコピーしました。` : 'コピーできませんでした。手動で選択してください。', { duration: 3000 });
  }

  return (
    <Card className="stack">
      <h2>相手を招待</h2>
      {invite ? (
        <>
          <p className="small">招待リンク（有効期限 {formatDateTimeJa(invite.expiresAt)}、1回限り）</p>
          <code className="acc-code">{link}</code>
          <div className="row">
            <Button onClick={() => copy(link, '招待リンク')}>リンクをコピー</Button>
            {canShare() && <Button onClick={() => shareText('Baby hub に参加してください。', link)}>共有する</Button>}
          </div>
          <details>
            <summary>招待コードで渡す</summary>
            <p className="small muted">リンクが開けない場合は、相手が「参加」画面でこのコードを貼り付けます。</p>
            <code className="acc-code">{invite.token}</code>
            <Button onClick={() => copy(invite.token, '招待コード')}>コードをコピー</Button>
          </details>
          <p className="small muted">リンクやコードを知っている人は参加できます。相手本人にだけ渡してください。この画面を閉じると表示できなくなるため、必要なら再発行してください。</p>
          <div className="row">
            <Button loading={busy} onClick={create}>再発行（以前の招待は無効）</Button>
            <Button variant="danger" disabled={busy} onClick={revoke}>失効する</Button>
          </div>
        </>
      ) : (
        <>
          <p className="small muted">招待リンクは作成時にだけ表示されます。有効期限は24時間、1回限りです。メンバーは2人までです。</p>
          <Button variant="primary" loading={busy} onClick={create}>招待を作成</Button>
        </>
      )}
    </Card>
  );
}

export function FamilySection() {
  const { user } = useAuth();
  const { familyId, family, role, members, activeMembers } = useFamily();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // 移譲の再認証シート（提案: 相手 uid / 承諾: 'accept'）
  const [flow, setFlow] = useState<{ type: 'propose'; uid: string; name: string } | { type: 'accept' } | null>(null);
  if (!familyId) return null;
  const tv = transferView(family?.pendingOwnerTransfer, user?.uid, Date.now());
  const nameOf = (uid: string) => members.find((m) => m.uid === uid)?.displayName || '（名前なし）';
  const isOwner = role === 'owner';
  const others = activeMembers.filter((m) => m.uid !== user?.uid);

  async function run(fn: () => Promise<unknown>, ok: string, errMap?: (e: unknown, f: string) => string) {
    setBusy(true);
    try { await fn(); toast.show(ok); return true; }
    catch (e) { const f = apiErrorMessage(e); toast.show(errMap ? errMap(e, f) : f, { tone: 'error', duration: 8000 }); return false; }
    finally { setBusy(false); }
  }
  const remove = (uid: string, name: string) => {
    if (window.confirm(`${name} さんを家族から外しますか？ 共有済みの記録は残り、記録者は「退出したメンバー」と表示されます。`))
      run(() => api.removeMember({ familyId, uid }), 'メンバーを外しました。');
  };
  const cancelTransfer = () => {
    if (window.confirm(tv.kind === 'recipient' ? '管理者の移譲を辞退しますか？' : '管理者の移譲の提案を取り消しますか？'))
      run(() => api.cancelOwnershipTransfer({ familyId }), tv.kind === 'recipient' ? '移譲を辞退しました。' : '提案を取り消しました。', transferErrorMessage);
  };
  const leave = async () => {
    if (isOwner && others.length > 0) { toast.show('管理者は先に他のメンバーへ管理者を移譲してから退出してください。', { tone: 'error', duration: 8000 }); return; }
    if (!window.confirm('この家族から退出しますか？ 共有済みの記録は家族に残り、あなたの記録者表示は「退出したメンバー」になります。通知とアクセス権は失われます。')) return;
    if (await run(() => api.leaveFamily({ familyId }), '退出しました。', leaveErrorMessage)) {
      // 退出後は端末に残った家族データ（信頼端末の永続キャッシュ）を消してから /setup へ
      await clearLocalData();
      window.location.replace('/setup');
    }
  };

  return (
    <SubPage title="家族">
      <Card className="stack">
        <h2>{family?.name ?? '家族'}</h2>
        <ul className="acc-list">
          {members.map((m) => (
            <li key={m.uid}>
              <span>
                {m.displayName || '（名前なし）'}{m.uid === user?.uid && '（あなた）'}
                <span className="small muted"> {ROLE[m.role] ?? m.role}・{STATUS[m.status] ?? m.status}</span>
              </span>
              {isOwner && m.status === 'active' && m.uid !== user?.uid && (
                <span className="row">
                  <Button disabled={busy || tv.kind !== 'none'} onClick={() => setFlow({ type: 'propose', uid: m.uid, name: m.displayName })}>管理者を移譲</Button>
                  <Button variant="danger" disabled={busy} onClick={() => remove(m.uid, m.displayName)}>外す</Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {tv.kind !== 'none' && (
        <Card tone={tv.kind === 'recipient' ? 'warning' : 'handover'} className="stack" role="status">
          {tv.kind === 'recipient' && <>
            <h2>管理者の移譲が提案されています</h2>
            <p className="small">{nameOf(tv.proposedBy)} さんから、あなたに管理者を移譲する提案が届いています。承諾すると、あなたが管理者（招待・メンバー削除・データ削除ができる人）になり、{nameOf(tv.proposedBy)} さんは一般メンバーになります。</p>
          </>}
          {tv.kind === 'proposer' && <>
            <h2>管理者の移譲を提案中</h2>
            <p className="small">{nameOf(tv.toUid)} さんの承諾を待っています。承諾されるまで、あなたが管理者のままです。</p>
          </>}
          {tv.kind === 'other' && <>
            <h2>管理者の移譲が提案中です</h2>
            <p className="small">{nameOf(tv.proposedBy)} さんが {nameOf(tv.toUid)} さんへの管理者移譲を提案しています。</p>
          </>}
          <p className={`small ${tv.expired ? 'acc-err' : 'muted'}`}>
            {tv.expired ? `提案の有効期限が切れました（${formatDateTimeJa(new Date(tv.expiresAtMs).toISOString())}）。${tv.kind === 'proposer' ? '取り消してから、必要ならもう一度提案してください。' : ''}` : `有効期限 ${formatDateTimeJa(new Date(tv.expiresAtMs).toISOString())}`}
          </p>
          <div className="row">
            {tv.kind === 'recipient' && <Button variant="primary" disabled={busy || tv.expired} onClick={() => setFlow({ type: 'accept' })}>承諾する（本人確認）</Button>}
            {(tv.kind === 'recipient' || tv.kind === 'proposer') && <Button disabled={busy} onClick={cancelTransfer}>{tv.kind === 'recipient' ? '辞退する' : '提案を取り消す'}</Button>}
          </div>
        </Card>
      )}

      {isOwner && <InvitePanel familyId={familyId} />}

      <Card className="stack">
        <h2>家族から退出</h2>
        <p className="small">退出すると、この家族の情報にアクセスできなくなり、通知も止まります。共有済みの記録は家族に残ります。アカウント自体は残るので、別の家族に参加することもできます。</p>
        {isOwner && others.length > 0 && <p className="small acc-err">あなたは管理者です。退出する前に、他のメンバーへ管理者を移譲してください。</p>}
        {isOwner && others.length === 0 && <p className="small">他のメンバーがいない場合は、退出ではなく「アカウント・削除」から家族データの削除を行います。</p>}
        <Button variant="danger" disabled={busy || (isOwner && others.length === 0)} onClick={leave}>退出する</Button>
      </Card>

      <DangerFlow open={flow?.type === 'propose'} onClose={() => setFlow(null)} title="管理者を移譲する" actionLabel="本人確認して提案" variant="primary" errorMessage={transferErrorMessage}
        run={async () => {
          if (flow?.type !== 'propose') return;
          await api.transferOwnership({ familyId, toUid: flow.uid });
          setFlow(null);
          toast.show(`${flow.name} さんに移譲を提案しました。承諾されると管理者が交代します。`, { duration: 6000 });
        }}>
        <p>管理者を {flow?.type === 'propose' ? flow.name : ''} さんに移譲する提案を送ります。相手が承諾するまで、あなたが管理者のままです。承諾されると、あなたは一般メンバーになり、招待・メンバー削除・データ削除などの管理操作ができなくなります。</p>
      </DangerFlow>

      <DangerFlow open={flow?.type === 'accept'} onClose={() => setFlow(null)} title="管理者を引き受ける" actionLabel="本人確認して承諾" variant="primary" errorMessage={transferErrorMessage}
        run={async () => {
          await api.acceptOwnershipTransfer({ familyId });
          setFlow(null);
          toast.show('管理者になりました。');
        }}>
        <p>承諾すると、あなたがこの家族の管理者になります。招待・メンバー削除・家族データの削除ができるようになります。</p>
      </DangerFlow>
    </SubPage>
  );
}
