// 受診メモ（MedicalVisit）
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { paths, useCollection, useDocument, createFamilyDoc } from '../../lib/db';
import { apiErrorMessage } from '../../lib/api';
import { doc, orderBy, query } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { todayStr, formatDateJa } from '../../lib/time';
import { Button, Card, ConflictNotice, EmptyState, Field, SyncBadge, syncStateOf, TextArea, TextInput, useToast } from '../../components';
import { PageHeader, useIds, useSaver } from './shared';
import type { MedicalVisit } from '../../types/models';

interface Form { occurredOn: string; provider: string; reason: string; observations: string; questions: string; clinicianInstructions: string; nextAction: string }
const toForm = (v?: MedicalVisit | null): Form => ({
  occurredOn: v?.occurredOn ?? todayStr(), provider: v?.provider ?? '', reason: v?.reason ?? '', observations: v?.observations ?? '',
  questions: v?.questions ?? '', clinicianInstructions: v?.clinicianInstructions ?? '', nextAction: v?.nextAction ?? '',
});
const opt = (s: string) => (s.trim() ? s.trim() : undefined);

function VisitFields({ f, set, touched }: { f: Form; set: (p: Partial<Form>) => void; touched: boolean }) {
  const req = (v: string) => (touched && !v.trim() ? '入力してください' : undefined);
  return (
    <div className="stack">
      <Field label="受診日" error={touched && !f.occurredOn ? '入力してください' : undefined}>{({ id }) => <TextInput id={id} type="date" value={f.occurredOn} onChange={(e) => set({ occurredOn: e.target.value })} />}</Field>
      <Field label="医療機関" error={req(f.provider)}>{({ id }) => <TextInput id={id} maxLength={200} value={f.provider} onChange={(e) => set({ provider: e.target.value })} />}</Field>
      <Field label="目的・理由" error={req(f.reason)}>{({ id }) => <TextInput id={id} maxLength={200} value={f.reason} onChange={(e) => set({ reason: e.target.value })} />}</Field>
      <Field label="気づいたこと（保護者の観察）" optional>{({ id }) => <TextArea id={id} maxLength={2000} value={f.observations} onChange={(e) => set({ observations: e.target.value })} />}</Field>
      <Field label="質問したいこと" optional>{({ id }) => <TextArea id={id} maxLength={2000} value={f.questions} onChange={(e) => set({ questions: e.target.value })} />}</Field>
      <Field label="医師から説明されたこと（確認済み情報）" optional hint="医師・医療機関から聞いた内容だけを書いてください">{({ id }) => <TextArea id={id} maxLength={2000} value={f.clinicianInstructions} onChange={(e) => set({ clinicianInstructions: e.target.value })} />}</Field>
      <Field label="次回・次にすること" optional>{({ id }) => <TextArea id={id} maxLength={2000} value={f.nextAction} onChange={(e) => set({ nextAction: e.target.value })} />}</Field>
    </div>
  );
}
const invalid = (f: Form) => !f.occurredOn || !f.provider.trim() || !f.reason.trim();

export function VisitsPage() {
  const { familyId, childId } = useIds();
  const nav = useNavigate();
  const toast = useToast();
  const { data, loading } = useCollection<MedicalVisit>(familyId && childId ? query(paths.medicalVisits(familyId, childId), orderBy('occurredOn', 'desc')) : null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState<Form>(toForm());
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const create = async () => {
    setTouched(true);
    if (invalid(f) || !familyId || !childId) return;
    setBusy(true); setErr('');
    try {
      const id = await createFamilyDoc(paths.medicalVisits(familyId, childId).path, {
        occurredOn: f.occurredOn, provider: f.provider.trim(), reason: f.reason.trim(), observations: opt(f.observations), questions: opt(f.questions),
        clinicianInstructions: opt(f.clinicianInstructions), nextAction: opt(f.nextAction),
      });
      toast.show('受診メモを保存しました');
      setAdding(false); setF(toForm()); setTouched(false);
      nav(`/health/visits/${id}`);
    } catch (e) { setErr(apiErrorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="page">
      <PageHeader title="受診メモ" actions={!adding && <Button variant="primary" onClick={() => setAdding(true)} disabled={!childId}>追加</Button>} />
      {adding && (
        <Card>
          <h2>受診メモを追加</h2>
          <VisitFields f={f} set={(p) => setF({ ...f, ...p })} touched={touched} />
          {err && <div className="small ch-field__error" role="alert">{err}</div>}
          <div className="row" style={{ marginTop: 'var(--space-3)' }}>
            <Button variant="primary" onClick={create} loading={busy}>保存</Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>キャンセル</Button>
          </div>
          <p className="small muted">受診メモの保存は通信できるときに確定します。</p>
        </Card>
      )}
      {loading ? <p className="muted" role="status">読み込み中…</p> : data.length === 0 ? <EmptyState title="受診メモはまだありません" icon="info" /> : (
        <ul className="hl-list">
          {data.map((v) => (
            <li key={v.id}>
              <Link to={`/health/visits/${v.id}`} className="hl-card-link">
                <Card><strong>{formatDateJa(v.occurredOn)} {v.provider}</strong><span className="small">{v.reason}</span>{v.nextAction && <span className="small muted">次: {v.nextAction}</span>}</Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VisitDetailPage() {
  const { id = '' } = useParams();
  const { familyId, childId } = useIds();
  const toast = useToast();
  const { data, loading } = useDocument<MedicalVisit>(familyId && childId && id ? doc(db, paths.medicalVisits(familyId, childId).path, id) : null);
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Form>(toForm());
  const [touched, setTouched] = useState(false);
  const saver = useSaver();
  const start = () => { setF(toForm(data)); setEditing(true); setTouched(false); saver.clear(); };
  const save = async () => {
    setTouched(true);
    if (invalid(f) || !data) return;
    const ok = await saver.save('medicalVisit', data.id, data.revision, {
      occurredOn: f.occurredOn, provider: f.provider.trim(), reason: f.reason.trim(), observations: f.observations.trim() || null,
      questions: f.questions.trim() || null, clinicianInstructions: f.clinicianInstructions.trim() || null, nextAction: f.nextAction.trim() || null,
    });
    if (ok) { toast.show('保存しました'); setEditing(false); }
  };
  if (loading) return <div className="page"><PageHeader title="受診メモ" back="/health/visits" /><p className="muted" role="status">読み込み中…</p></div>;
  if (!data) return <div className="page"><PageHeader title="受診メモ" back="/health/visits" /><EmptyState title="見つかりません" icon="alert" /></div>;
  const sec = (label: string, v?: string, strong?: boolean) => (
    <Card tone={strong ? 'handover' : 'default'}><h2>{label}</h2><p style={{ whiteSpace: 'pre-wrap' }}>{v || <span className="muted">未入力</span>}</p></Card>
  );
  return (
    <div className="page">
      <PageHeader title="受診メモ" back="/health/visits" actions={!editing && <Button onClick={start}>編集</Button>} />
      <SyncBadge state={syncStateOf({ pending: data._pending })} />
      {editing ? (
        <div className="stack">
          {saver.conflict && <ConflictNotice onShowLatest={() => { saver.clear(); setEditing(false); }} onRetry={save} />}
          <VisitFields f={f} set={(p) => setF({ ...f, ...p })} touched={touched} />
          {saver.error && <div className="small ch-field__error" role="alert">{saver.error}</div>}
          <div className="row"><Button variant="primary" onClick={save} loading={saver.saving}>保存</Button><Button variant="ghost" onClick={() => setEditing(false)}>キャンセル</Button></div>
        </div>
      ) : (
        <>
          <Card><strong>{formatDateJa(data.occurredOn)}</strong><p>{data.provider}</p><p className="small">目的: {data.reason}</p></Card>
          {sec('気づいたこと（保護者の観察）', data.observations)}
          {sec('質問したいこと', data.questions)}
          {sec('医師から説明されたこと（確認済み情報）', data.clinicianInstructions, true)}
          {sec('次回・次にすること', data.nextAction)}
        </>
      )}
    </div>
  );
}
