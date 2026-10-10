// アレルギー・持病メモ・かかりつけ（healthProfiles/main）
import { useEffect, useState } from 'react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from '../../lib/firebase';
import { paths, stripUndefined, useDocument } from '../../lib/db';
import { apiErrorMessage } from '../../lib/api';
import { safeHttpsUrl, telHref } from '../../lib/safeUrl';
import { Button, Card, ConflictNotice, Field, Select, SyncBadge, syncStateOf, TextArea, TextInput, useToast } from '../../components';
import { PageHeader, useIds, useSaver } from './shared';
import type { HealthProfile } from '../../types/models';

type Allergy = HealthProfile['allergies'][number];
const CONF: { value: Allergy['confirmation']; label: string }[] = [
  { value: 'confirmed_by_doctor', label: '医師に確認済み' },
  { value: 'suspected', label: '保護者が疑っている' },
  { value: 'unconfirmed', label: '未確認' },
];
export const confLabel = (c: Allergy['confirmation']) => CONF.find((x) => x.value === c)?.label ?? '未確認';

interface Form { allergies: Allergy[]; conditionsNote: string; clinicName: string; clinicPhone: string; clinicUrl: string }
const toForm = (p: HealthProfile | null): Form => ({
  allergies: p?.allergies ?? [],
  conditionsNote: p?.conditionsNote ?? '',
  clinicName: p?.primaryClinic?.name ?? '',
  clinicPhone: p?.primaryClinic?.phone ?? '',
  clinicUrl: p?.primaryClinic?.url ?? '',
});

function buildClinic(f: Form) {
  if (!f.clinicName.trim()) return null;
  return { name: f.clinicName.trim(), ...(f.clinicPhone.trim() ? { phone: f.clinicPhone.trim() } : {}), ...(f.clinicUrl.trim() ? { url: f.clinicUrl.trim() } : {}) };
}
const cleanAllergies = (a: Allergy[]) =>
  a.filter((x) => x.name.trim()).map((x) => ({ name: x.name.trim(), confirmation: x.confirmation, ...(x.source?.trim() ? { source: x.source.trim() } : {}), ...(x.note?.trim() ? { note: x.note.trim() } : {}) }));

export function ProfilePage() {
  const { familyId, childId } = useIds();
  const toast = useToast();
  const { data, loading } = useDocument<HealthProfile>(familyId && childId ? paths.healthProfile(familyId, childId) : null);
  const [form, setForm] = useState<Form>(toForm(null));
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const saver = useSaver();

  useEffect(() => { if (!editing) setForm(toForm(data)); }, [data, editing]);

  const urlBad = form.clinicUrl.trim() !== '' && !form.clinicUrl.trim().startsWith('https://');

  const save = async () => {
    if (!familyId || !childId || urlBad) return;
    setErr('');
    const allergies = cleanAllergies(form.allergies);
    if (!data) {
      // 初回: 固定ID main で create（共通フィールド付与）
      const uid = auth.currentUser?.uid;
      if (!uid) return;
      setBusy(true);
      try {
        await setDoc(doc(db, paths.healthProfile(familyId, childId).path), stripUndefined({
          allergies,
          conditionsNote: form.conditionsNote.trim() || undefined,
          primaryClinic: buildClinic(form) ?? undefined,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: uid, updatedBy: uid, revision: 1,
        }));
        toast.show('保存しました');
        setEditing(false);
      } catch (e) { setErr(apiErrorMessage(e)); } finally { setBusy(false); }
      return;
    }
    const ok = await saver.save('healthProfile', 'main', data.revision, {
      allergies,
      conditionsNote: form.conditionsNote.trim() || null,
      primaryClinic: buildClinic(form),
    });
    if (ok) { toast.show('保存しました'); setEditing(false); }
  };

  const setAllergy = (i: number, patch: Partial<Allergy>) => setForm({ ...form, allergies: form.allergies.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  if (loading) return <div className="page"><PageHeader title="アレルギー・かかりつけ" /><p className="muted" role="status">読み込み中…</p></div>;

  return (
    <div className="page">
      <PageHeader title="アレルギー・かかりつけ" actions={!editing && <Button onClick={() => setEditing(true)} disabled={!familyId}>編集</Button>} />
      {data && <SyncBadge state={syncStateOf({ pending: data._pending })} />}
      <p className="small muted">初めて食べた食材のメモなどから、アレルギーが自動で登録されることはありません。「医師に確認済み」「疑い」「未確認」を区別して、本人が登録します。</p>
      {saver.conflict && <ConflictNotice onShowLatest={() => { saver.clear(); setEditing(false); }} onRetry={save} />}
      {(err || saver.error) && <Card tone="danger" role="alert">{err || saver.error}</Card>}

      {!editing ? (
        <>
          <Card>
            <h2>アレルギー</h2>
            {(data?.allergies ?? []).length === 0 ? <p className="muted">登録なし（「なし」と確認されたことを意味しません）</p> : (
              <ul className="hl-list">
                {data!.allergies.map((a, i) => (
                  <li key={i} className="hl-item">
                    <div className="row"><strong>{a.name}</strong><span className={`hl-badge ${a.confirmation === 'confirmed_by_doctor' ? 'hl-badge--ok' : 'hl-badge--warn'}`}>{confLabel(a.confirmation)}</span></div>
                    {a.source && <span className="small muted">説明元: {a.source}</span>}
                    {a.note && <span className="small">{a.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card><h2>持病・気をつけていること（メモ）</h2><p style={{ whiteSpace: 'pre-wrap' }}>{data?.conditionsNote || <span className="muted">未入力</span>}</p></Card>
          <Card>
            <h2>かかりつけ</h2>
            {data?.primaryClinic ? (
              <div className="stack">
                <strong>{data.primaryClinic.name}</strong>
                {data.primaryClinic.phone && <a href={telHref(data.primaryClinic.phone) ?? undefined}>{data.primaryClinic.phone}</a>}
                {safeHttpsUrl(data.primaryClinic.url) && <a href={safeHttpsUrl(data.primaryClinic.url)!} target="_blank" rel="noopener noreferrer">ウェブサイトを開く</a>}
              </div>
            ) : <span className="muted">未登録</span>}
          </Card>
        </>
      ) : (
        <div className="stack">
          <Card>
            <h2>アレルギー</h2>
            <div className="stack">
              {form.allergies.map((a, i) => (
                <div key={i} className="stack" style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--space-3)' }}>
                  <Field label="名称">{({ id }) => <TextInput id={id} maxLength={200} value={a.name} onChange={(e) => setAllergy(i, { name: e.target.value })} />}</Field>
                  <Field label="確認区分">{({ id }) => <Select id={id} value={a.confirmation} options={CONF} onChange={(v) => setAllergy(i, { confirmation: v as Allergy['confirmation'] })} />}</Field>
                  <Field label="説明元" optional>{({ id }) => <TextInput id={id} maxLength={200} value={a.source ?? ''} onChange={(e) => setAllergy(i, { source: e.target.value })} placeholder="例: ○○小児科で説明" />}</Field>
                  <Field label="メモ" optional>{({ id }) => <TextInput id={id} maxLength={200} value={a.note ?? ''} onChange={(e) => setAllergy(i, { note: e.target.value })} />}</Field>
                  <Button variant="danger" onClick={() => setForm({ ...form, allergies: form.allergies.filter((_, j) => j !== i) })}>この行を削除</Button>
                </div>
              ))}
              <Button disabled={form.allergies.length >= 5} onClick={() => setForm({ ...form, allergies: [...form.allergies, { name: '', confirmation: 'suspected' }] })}>アレルギーを追加{form.allergies.length >= 5 ? '（最大5件）' : ''}</Button>
            </div>
          </Card>
          <Field label="持病・気をつけていること" optional>{({ id }) => <TextArea id={id} maxLength={2000} value={form.conditionsNote} onChange={(e) => setForm({ ...form, conditionsNote: e.target.value })} />}</Field>
          <Card>
            <h2>かかりつけ</h2>
            <div className="stack">
              <Field label="名称" optional>{({ id }) => <TextInput id={id} maxLength={200} value={form.clinicName} onChange={(e) => setForm({ ...form, clinicName: e.target.value })} />}</Field>
              <Field label="電話番号" optional>{({ id }) => <TextInput id={id} type="tel" maxLength={200} value={form.clinicPhone} onChange={(e) => setForm({ ...form, clinicPhone: e.target.value })} />}</Field>
              <Field label="ウェブサイト（https:// のみ）" optional error={urlBad ? 'https:// から始まるURLを入力してください' : undefined}>
                {({ id }) => <TextInput id={id} inputMode="url" maxLength={200} value={form.clinicUrl} onChange={(e) => setForm({ ...form, clinicUrl: e.target.value })} />}
              </Field>
            </div>
          </Card>
          <div className="row">
            <Button variant="primary" onClick={save} loading={busy || saver.saving} disabled={urlBad}>保存</Button>
            <Button variant="ghost" onClick={() => { setEditing(false); setForm(toForm(data)); saver.clear(); }}>キャンセル</Button>
          </div>
        </div>
      )}
    </div>
  );
}
