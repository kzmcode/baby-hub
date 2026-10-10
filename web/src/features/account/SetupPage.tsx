import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiErrorMessage } from '../../lib/api';
import { useAuth } from '../../context';
import { Button, Card, Field, SegmentedControl, TextInput } from '../../components';
import { saveInvite } from './util';
import './account.css';

type Step = 'name' | 'family' | 'child';
type Birth = 'born' | 'expected';
const STEPS: { key: Step; label: string }[] = [
  { key: 'name', label: '1 あなた' }, { key: 'family', label: '2 家族' }, { key: 'child', label: '3 子ども' },
];

/**
 * S02 初期設定。作成成功後は招待を作って sessionStorage に保存し /more/family へ移動する
 * （家族が確定すると routes の SetupGuard がこのページを外すため、招待表示は家族画面で行う）
 */
export function SetupPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState<Step>('name');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [familyName, setFamilyName] = useState('');
  const [nickname, setNickname] = useState('');
  const [birth, setBirth] = useState<Birth>('born');
  const [date, setDate] = useState('');
  const [isSample, setIsSample] = useState(false);
  const [inviteLater, setInviteLater] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function next(ev: FormEvent) {
    ev.preventDefault();
    setError('');
    if (step === 'name') { setStep('family'); return; }
    if (step === 'family') { setStep('child'); return; }
    setBusy(true);
    try {
      const child: { nickname: string; birthDate?: string; dueDate?: string; isSample?: boolean } = { nickname: nickname.trim() };
      if (date) { if (birth === 'born') child.birthDate = date; else child.dueDate = date; }
      if (isSample) child.isSample = true;
      const { familyId } = await api.createFamily({ familyName: familyName.trim(), displayName: displayName.trim(), child });
      let dest = '/';
      if (!inviteLater) {
        try {
          const inv = await api.createInvite({ familyId });
          saveInvite(inv);
          dest = '/more/family';
        } catch { dest = '/more/family'; /* 招待は家族画面で作り直せる */ }
      }
      nav(dest, { replace: true });
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusy(false);
    }
  }

  const ok = step === 'name' ? !!displayName.trim() : step === 'family' ? !!familyName.trim() : !!nickname.trim();

  return (
    <main className="page stack acc-narrow">
      <h1>はじめての設定</h1>
      <div className="acc-steps" aria-label="進行状況">
        {STEPS.map((s) => <span key={s.key} className={s.key === step ? 'is-on' : ''} aria-current={s.key === step ? 'step' : undefined}>{s.label}</span>)}
      </div>
      <form className="stack" onSubmit={next}>
        {step === 'name' && (
          <Card className="stack">
            <Field label="あなたの表示名" hint="家族のメンバーに表示されます（例: ママ、パパ、名前）">
              {(p) => <TextInput {...p} maxLength={50} required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
            </Field>
          </Card>
        )}
        {step === 'family' && (
          <Card className="stack">
            <Field label="家族の名前" hint="例: 鈴木家。管理者が家族データを削除するときの確認にも使います">
              {(p) => <TextInput {...p} maxLength={50} required value={familyName} onChange={(e) => setFamilyName(e.target.value)} />}
            </Field>
            <p className="small muted">1人につき1つの家族に所属できます。相手は次の手順で招待します。</p>
          </Card>
        )}
        {step === 'child' && (
          <Card className="stack">
            <Field label="子どもの呼び名" hint="本名でなくても構いません（例: 太郎、赤ちゃん）">
              {(p) => <TextInput {...p} maxLength={50} required value={nickname} onChange={(e) => setNickname(e.target.value)} />}
            </Field>
            <SegmentedControl<Birth>
              ariaLabel="出生の状況"
              options={[{ value: 'born', label: '生まれている' }, { value: 'expected', label: 'まだ（出産予定）' }]}
              value={birth} onChange={setBirth}
            />
            <Field label={birth === 'born' ? '出生日' : '出産予定日'} optional hint={birth === 'expected' ? '未定なら空のままで構いません。確定後に設定から入力できます' : undefined}>
              {(p) => <TextInput {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
            </Field>
            <label className="acc-check">
              <input type="checkbox" checked={isSample} onChange={(e) => setIsSample(e.target.checked)} />
              <span>練習用サンプルとして始める<span className="small muted"> — 出生前に操作を試すための練習データです。「練習データ」と表示され、本番の記録とは別に扱ってください。</span></span>
            </label>
            <label className="acc-check">
              <input type="checkbox" checked={inviteLater} onChange={(e) => setInviteLater(e.target.checked)} />
              <span>相手の招待はあとで行う</span>
            </label>
          </Card>
        )}
        {error && <p className="acc-err" role="alert">{error}</p>}
        <div className="row">
          {step !== 'name' && <Button onClick={() => setStep(step === 'child' ? 'family' : 'name')} disabled={busy}>戻る</Button>}
          <span className="spacer" />
          <Button type="submit" variant="primary" disabled={!ok} loading={busy}>{step === 'child' ? '作成して招待へ進む' : '次へ'}</Button>
        </div>
      </form>
    </main>
  );
}
