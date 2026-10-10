import { useEffect, useState, type FormEvent } from 'react';
import { api, apiErrorMessage } from '../../lib/api';
import { useFamily } from '../../context';
import { Button, Card, ConflictNotice, Field, TextInput, useToast } from '../../components';
import { SubPage } from './SubPage';

export function ChildSection() {
  const { familyId, childId, child } = useFamily();
  const toast = useToast();
  const [nickname, setNickname] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    setNickname(child?.nickname ?? ''); setBirthDate(child?.birthDate ?? ''); setDueDate(child?.dueDate ?? '');
    setConflict(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [childId]);

  if (!familyId || !childId || !child) return <SubPage title="子ども"><p className="muted">子どもの情報がありません。</p></SubPage>;

  async function save(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true); setError('');
    try {
      await api.updateDoc({
        familyId: familyId!, kind: 'child', docId: childId!, expectedRevision: child!.revision,
        patch: { nickname: nickname.trim(), birthDate: birthDate || null, dueDate: dueDate || null },
      });
      toast.show('保存しました。');
    } catch (e) {
      if ((e as { isConflict?: boolean }).isConflict) setConflict(true); else setError(apiErrorMessage(e));
    }
    setBusy(false);
  }

  return (
    <SubPage title="子ども">
      <Card>
        <form className="stack" onSubmit={save}>
          {child.isSample && <p><span className="acc-badge">練習データ</span></p>}
          <Field label="呼び名">{(p) => <TextInput {...p} required maxLength={50} value={nickname} onChange={(e) => setNickname(e.target.value)} />}</Field>
          <Field label="出生日" optional>{(p) => <TextInput {...p} type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />}</Field>
          <Field label="出産予定日" optional hint="出生日が確定したら出生日を入力してください">{(p) => <TextInput {...p} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}</Field>
          {conflict && <ConflictNotice onShowLatest={load} onRetry={load} message="他の人が先に更新しました。最新の内容を確認してください。" />}
          {error && <p className="acc-err" role="alert">{error}</p>}
          <Button type="submit" variant="primary" loading={busy} disabled={!nickname.trim()}>保存</Button>
        </form>
      </Card>
      {child.isSample && (
        <Card tone="warning" className="stack">
          <h2>練習データから本番へ</h2>
          <p className="small">この子どもは「練習用サンプル」です。練習の記録が本番の集計に混ざらないよう、出生後は次の手順で実データを始めてください。</p>
          <ol className="small">
            <li>「アカウント・削除」で、家族データを削除します（出力しておくこともできます）。</li>
            <li>もう一度「はじめての設定」から家族と子どもを作り直し、「練習用サンプルとして始める」を<strong>オフ</strong>にします。</li>
            <li>相手を再度招待します。</li>
          </ol>
        </Card>
      )}
    </SubPage>
  );
}
