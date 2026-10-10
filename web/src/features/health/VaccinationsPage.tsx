// 予防接種・健診（手動記録）。予約と実施を分ける。日付の自動計算はしない
import { useState } from 'react';
import { query } from 'firebase/firestore';
import { paths, useCollection, createFamilyDoc, type WithMeta } from '../../lib/db';
import { api, apiErrorMessage } from '../../lib/api';
import { formatDateJa } from '../../lib/time';
import { Button, Card, ConflictNotice, EmptyState, Field, Select, Sheet, SegmentedControl, SyncBadge, syncStateOf, TextInput, useToast } from '../../components';
import { PageHeader, useIds, useSaver } from './shared';
import type { Vaccination } from '../../types/models';

type Vac = WithMeta<Vaccination>;
const STATUS: { value: Vaccination['status']; label: string }[] = [
  { value: 'planned', label: '予定（未予約）' }, { value: 'reserved', label: '予約済み' }, { value: 'administered', label: '接種・受診済み' }, { value: 'cancelled', label: '取消' },
];
const statusLabel = (s: string) => STATUS.find((x) => x.value === s)?.label ?? s;

interface Form { kind: Vaccination['kind']; name: string; doseLabel: string; status: Vaccination['status']; scheduledDate: string; administeredDate: string; provider: string; source: string }
const toForm = (v?: Vac | null): Form => ({
  kind: v?.kind ?? 'vaccination', name: v?.name ?? '', doseLabel: v?.doseLabel ?? '', status: v?.status ?? 'planned',
  scheduledDate: v?.scheduledDate ?? '', administeredDate: v?.administeredDate ?? '', provider: v?.provider ?? '', source: v?.source ?? '',
});

export function VaccinationsPage() {
  const { familyId, childId } = useIds();
  const { data, loading } = useCollection<Vaccination>(familyId && childId ? query(paths.vaccinations(familyId, childId)) : null);
  const [editing, setEditing] = useState<Vac | 'new' | null>(null);
  const sorted = [...data].sort((a, b) => (b.administeredDate ?? b.scheduledDate ?? '9999').localeCompare(a.administeredDate ?? a.scheduledDate ?? '9999'));
  const groups: { title: string; items: Vac[] }[] = [
    { title: '予定・予約', items: sorted.filter((v) => v.status === 'planned' || v.status === 'reserved') },
    { title: '実施済み', items: sorted.filter((v) => v.status === 'administered') },
    { title: '取消', items: sorted.filter((v) => v.status === 'cancelled') },
  ];
  return (
    <div className="page">
      <PageHeader title="予防接種・健診" actions={<Button variant="primary" onClick={() => setEditing('new')} disabled={!childId}>追加</Button>} />
      <Card tone="warning"><p className="small">日付や回数は手入力した内容です。アプリが接種日や間隔を計算・提案することはありません。接種できるか・間隔・遅れた場合の対応は、医療機関や自治体に確認してください。</p></Card>
      {loading ? <p className="muted" role="status">読み込み中…</p> : data.length === 0 ? <EmptyState title="まだ登録がありません" icon="info" /> : groups.map((g) => g.items.length > 0 && (
        <section key={g.title} className="stack">
          <h2>{g.title}</h2>
          <ul className="hl-list">
            {g.items.map((v) => (
              <li key={v.id}>
                <Card>
                  <div className="row"><strong>{v.name}</strong><span className="hl-badge">{v.kind === 'checkup' ? '健診' : '予防接種'}</span><span className="hl-badge">{statusLabel(v.status)}</span><SyncBadge state={syncStateOf({ pending: v._pending })} /></div>
                  {v.doseLabel && <span className="small">{v.doseLabel}</span>}
                  {v.scheduledDate && <span className="small">予定日: {formatDateJa(v.scheduledDate)}</span>}
                  {v.administeredDate && <span className="small">実施日: {formatDateJa(v.administeredDate)}</span>}
                  {v.provider && <span className="small muted">機関: {v.provider}</span>}
                  {v.scheduleId && <span className="small muted">予定に追加済み</span>}
                  <div><Button variant="ghost" onClick={() => setEditing(v)}>編集</Button></div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {familyId && childId && editing && <VacSheet vac={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function VacSheet({ vac, onClose }: { vac: Vac | null; onClose: () => void }) {
  const { familyId, childId } = useIds();
  const toast = useToast();
  const saver = useSaver();
  const [f, setF] = useState<Form>(toForm(vac));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (p: Partial<Form>) => setF({ ...f, ...p });
  const bad = !f.name.trim() || (f.status === 'administered' && !f.administeredDate);
  const fields = () => ({
    kind: f.kind, name: f.name.trim(), doseLabel: f.doseLabel.trim(), status: f.status,
    scheduledDate: f.scheduledDate || null, administeredDate: f.administeredDate || null, provider: f.provider.trim() || null, source: f.source.trim() || null,
  });
  const submit = async () => {
    setTouched(true);
    if (bad || !familyId || !childId) return;
    if (!vac) {
      setBusy(true); setErr('');
      try {
        await createFamilyDoc(paths.vaccinations(familyId, childId).path, {
          kind: f.kind, name: f.name.trim(), doseLabel: f.doseLabel.trim(), status: f.status,
          scheduledDate: f.scheduledDate || undefined, administeredDate: f.administeredDate || undefined, provider: f.provider.trim() || undefined, source: f.source.trim() || undefined,
        });
        toast.show('保存しました'); onClose();
      } catch (e) { setErr(apiErrorMessage(e)); } finally { setBusy(false); }
      return;
    }
    if (await saver.save('vaccination', vac.id, vac.revision, fields())) { toast.show('保存しました'); onClose(); }
  };
  const addToSchedule = async () => {
    if (!vac || !familyId || !childId || !vac.scheduledDate) return;
    setBusy(true); setErr('');
    try {
      const sid = await createFamilyDoc(paths.schedules(familyId).path, {
        title: `${vac.name}${vac.doseLabel ? ` ${vac.doseLabel}` : ''}`, category: 'medical', childId, allDay: true, date: vac.scheduledDate,
        location: vac.provider || undefined, timezone: 'Asia/Tokyo', assigneeUids: [], status: 'planned',
        relatedRefs: [{ kind: 'vaccination', id: vac.id, childId }],
      });
      void api.syncScheduleReminder({ familyId, scheduleId: sid }).catch(() => {});
      if (await saver.save('vaccination', vac.id, vac.revision, { scheduleId: sid })) { toast.show('予定に追加しました'); onClose(); }
    } catch (e) { setErr(apiErrorMessage(e)); } finally { setBusy(false); }
  };
  const e = (c: boolean, m: string) => (touched && c ? m : undefined);
  return (
    <Sheet open onClose={onClose} title={vac ? '予防接種・健診を編集' : '予防接種・健診を追加'} footer={<Button variant="primary" block onClick={submit} loading={busy || saver.saving}>保存</Button>}>
      <div className="stack">
        {saver.conflict && <ConflictNotice onShowLatest={() => { saver.clear(); onClose(); }} onRetry={submit} />}
        <SegmentedControl ariaLabel="種類" value={f.kind} onChange={(kind) => set({ kind })} options={[{ value: 'vaccination', label: '予防接種' }, { value: 'checkup', label: '健診' }]} />
        <Field label="名称" error={e(!f.name.trim(), '入力してください')}>{({ id }) => <TextInput id={id} maxLength={200} value={f.name} onChange={(ev) => set({ name: ev.target.value })} />}</Field>
        <Field label="回次" optional>{({ id }) => <TextInput id={id} maxLength={100} value={f.doseLabel} onChange={(ev) => set({ doseLabel: ev.target.value })} placeholder="例: 1回目／3〜4か月児健診" />}</Field>
        <Field label="状態">{({ id }) => <Select id={id} value={f.status} options={STATUS} onChange={(v) => set({ status: v as Vaccination['status'] })} />}</Field>
        <Field label="予約・予定日" optional>{({ id }) => <TextInput id={id} type="date" value={f.scheduledDate} onChange={(ev) => set({ scheduledDate: ev.target.value })} />}</Field>
        <Field label="実施日" optional error={e(f.status === 'administered' && !f.administeredDate, '実施済みの場合は実施日を入力してください')}>{({ id }) => <TextInput id={id} type="date" value={f.administeredDate} onChange={(ev) => set({ administeredDate: ev.target.value })} />}</Field>
        <Field label="医療機関・会場" optional>{({ id }) => <TextInput id={id} maxLength={200} value={f.provider} onChange={(ev) => set({ provider: ev.target.value })} />}</Field>
        <Field label="情報元" optional>{({ id }) => <TextInput id={id} maxLength={200} value={f.source} onChange={(ev) => set({ source: ev.target.value })} placeholder="例: 自治体の案内、母子手帳" />}</Field>
        {err && <div className="small ch-field__error" role="alert">{err}</div>}
        {saver.error && <div className="small ch-field__error" role="alert">{saver.error}</div>}
        {vac && vac.scheduledDate && !vac.scheduleId && vac.status !== 'cancelled' && <Button onClick={addToSchedule} loading={busy}>予定にも追加（{formatDateJa(vac.scheduledDate)}）</Button>}
      </div>
    </Sheet>
  );
}
