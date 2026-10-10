// 薬（F12）: 登録・実施フロー（担当取得→実施確定）。用量は算出しない
import { useMemo, useRef, useState } from 'react';
import { query, where } from 'firebase/firestore';
import { useFamily } from '../../context';
import { paths, useCollection, createFamilyDoc, type WithMeta } from '../../lib/db';
import { api, apiErrorMessage, ApiError } from '../../lib/api';
import { useSyncStatus } from '../../lib/sync';
import { formatElapsed, todayStr } from '../../lib/time';
import { Button, Card, ConflictNotice, EmptyState, Field, Sheet, TextArea, TextInput, useToast } from '../../components';
import { PageHeader, WhenField, newWhen, resolveWhen, tsToDate, useIds, useRecentEvents, useSaver, dateTimeText } from './shared';
import { isMedicationInPeriod, lastDoseMap, type DoseEventLike } from './logic/dose';
import { parseNum } from './logic/units';
import type { DoseOccurrence, Medication } from '../../types/models';

type Med = WithMeta<Medication>;
type Occ = WithMeta<DoseOccurrence>;

export function MedicationsPage() {
  const { familyId, childId } = useIds();
  const { online } = useSyncStatus();
  const { memberName } = useFamily();
  const meds = useCollection<Medication>(familyId && childId ? paths.medications(familyId, childId) : null);
  const occs = useCollection<DoseOccurrence>(
    familyId && childId ? query(paths.doseOccurrences(familyId, childId), where('state', 'in', ['planned', 'claimed'])) : null,
  );
  const taken = useRecentEvents(['medication_taken'], 100);
  const [editing, setEditing] = useState<Med | 'new' | null>(null);
  const [completing, setCompleting] = useState<{ med: Med; occ: Occ } | null>(null);
  const [showEnded, setShowEnded] = useState(false);

  const last = useMemo(() => {
    const list: DoseEventLike[] = taken.data.map((e) => ({ id: e.id, occurredAt: tsToDate(e.occurredAt), caregiverUid: e.caregiverUid, medicationId: String((e.payload as { medicationId?: string }).medicationId ?? '') }));
    return lastDoseMap(list);
  }, [taken.data]);

  const active = meds.data.filter((m) => m.status === 'active');
  const ended = meds.data.filter((m) => m.status !== 'active');
  const today = todayStr();

  return (
    <div className="page">
      <PageHeader title="薬" actions={<Button variant="primary" onClick={() => setEditing('new')} disabled={!familyId || !childId}>薬を登録</Button>} />
      <Card tone="warning">
        <p className="small">このアプリは薬の量や回数を計算・提案せず、飲ませてよいかの判断もしません。処方箋・薬の説明書・医師や薬剤師の指示のとおりに使ってください。</p>
        <p className="small">服薬の記録は通信できるときだけ確定できます。{!online && <strong>いまはオフラインのため、「飲ませた」の記録は確定できません。</strong>}</p>
      </Card>
      {meds.loading ? <p className="muted" role="status">読み込み中…</p> : active.length === 0 ? (
        <EmptyState title="有効な薬はありません" description="処方された薬を、指示の文言どおりに登録します。" icon="medication" />
      ) : (
        <ul className="hl-list">
          {active.map((m) => {
            const l = last.get(m.id);
            const open = occs.data.filter((o) => o.medicationId === m.id);
            const out = !isMedicationInPeriod(m, today);
            return (
              <li key={m.id}>
                <Card>
                  <div className="row"><strong>{m.name}</strong>{m.asNeeded && <span className="hl-badge">頓服</span>}{out && <span className="hl-badge hl-badge--warn">登録した期間の外</span>}</div>
                  <p className="small">指示（転記）: {m.instructionText}</p>
                  {(m.amount !== undefined || m.unit) && <p className="small muted">指示の量: {m.amount ?? ''}{m.unit ?? ''}</p>}
                  <p className="small muted">指示の出所: {m.instructionSource}{m.startDate || m.endDate ? ` ／ 期間 ${m.startDate ?? ''}〜${m.endDate ?? ''}` : ''}</p>
                  <p><strong>{l ? `最後に飲ませたのは ${formatElapsed(l.occurredAt)}（${memberName(l.caregiverUid)}）` : '記録上、飲ませた実績はありません'}</strong></p>
                  {l && <p className="small muted">{dateTimeText(l.occurredAt)}（記録されたもののみ。未記録の分は含まれません）</p>}
                  <Doses med={m} occs={open} online={online} onComplete={(occ) => setCompleting({ med: m, occ })} />
                  <div className="row">
                    <Button variant="ghost" onClick={() => setEditing(m)}>登録内容を編集</Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {ended.length > 0 && (
        <div className="stack">
          <Button variant="ghost" onClick={() => setShowEnded(!showEnded)}>{showEnded ? '終了した薬を隠す' : `終了した薬を表示（${ended.length}）`}</Button>
          {showEnded && <ul className="hl-list">{ended.map((m) => (
            <li key={m.id}><Card><strong>{m.name}</strong><p className="small muted">{m.instructionText}</p><Button variant="ghost" onClick={() => setEditing(m)}>編集</Button></Card></li>
          ))}</ul>}
        </div>
      )}
      {familyId && childId && editing && <MedSheet med={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {familyId && childId && completing && <CompleteSheet med={completing.med} occ={completing.occ} last={last.get(completing.med.id)} online={online} onClose={() => setCompleting(null)} />}
    </div>
  );
}

function Doses({ med, occs, online, onComplete }: { med: Med; occs: Occ[]; online: boolean; onComplete: (o: Occ) => void }) {
  const { familyId, childId } = useIds();
  const { memberName } = useFamily();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const myUid = useMyUid();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg('');
    try { await fn(); } catch (e) {
      if (e instanceof ApiError && e.code === 'failed-precondition' && (e.details as { claimedBy?: string } | undefined)?.claimedBy) {
        setMsg(`${memberName((e.details as { claimedBy: string }).claimedBy)}さんが対応中です。確認してください`);
      } else setMsg(apiErrorMessage(e));
    } finally { setBusy(false); }
  };
  const start = (occ?: Occ) => run(async () => {
    if (!familyId || !childId) return;
    const occurrenceId = occ?.id ?? (await api.createDoseOccurrence({ familyId, childId, medicationId: med.id })).occurrenceId;
    await api.claimDose({ familyId, childId, occurrenceId });
    toast.show('担当になりました。飲ませたら「飲ませた」を押してください');
  });
  const release = (o: Occ) => run(async () => { if (familyId && childId) await api.releaseDose({ familyId, childId, occurrenceId: o.id }); });
  const skip = (o: Occ) => run(async () => { if (familyId && childId) await api.skipDose({ familyId, childId, occurrenceId: o.id, reason: '見送り' }); });

  const mine = occs.filter((o) => o.state === 'claimed' && o.claimedBy === myUid);
  const others = occs.filter((o) => o.state === 'claimed' && o.claimedBy !== myUid);
  const planned = occs.filter((o) => o.state === 'planned');
  return (
    <div className="stack">
      {msg && <div className="small ch-field__error" role="alert">{msg}</div>}
      {others.map((o) => <Card key={o.id} tone="warning" role="status">{memberName(o.claimedBy)}さんが対応中です。確認してください</Card>)}
      {mine.map((o) => (
        <div key={o.id} className="row">
          <Button variant="primary" onClick={() => onComplete(o)} disabled={!online || busy}>飲ませた</Button>
          <Button onClick={() => release(o)} disabled={!online || busy}>やめる（担当を外す）</Button>
          <Button variant="ghost" onClick={() => skip(o)} disabled={!online || busy}>見送り</Button>
        </div>
      ))}
      {planned.map((o) => <div key={o.id} className="row"><Button variant="primary" onClick={() => start(o)} disabled={!online || busy}>これから飲ませる（予定分）</Button></div>)}
      {mine.length === 0 && planned.length === 0 && (
        <Button variant="primary" onClick={() => start()} disabled={!online || busy}>これから飲ませる</Button>
      )}
      {!online && <p className="small muted">オフラインのため実施は確定できません。通信が戻ってから操作してください。</p>}
    </div>
  );
}

import { auth } from '../../lib/firebase';
function useMyUid(): string | null { return auth.currentUser?.uid ?? null; }

function CompleteSheet({ med, occ, last, online, onClose }: { med: Med; occ: Occ; last?: DoseEventLike; online: boolean; onClose: () => void }) {
  const { familyId, childId } = useIds();
  const { memberName } = useFamily();
  const toast = useToast();
  // 再送でも同一ID（シートを開いている間は固定）
  const eventId = useRef(crypto.randomUUID());
  const [when, setWhen] = useState(newWhen());
  const [amount, setAmount] = useState(med.amount !== undefined ? String(med.amount) : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (!familyId || !childId) return;
    const a = parseNum(amount);
    if (amount.trim() !== '' && a === null) { setErr('量は数字で入力してください'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.completeDose({
        familyId, childId, occurrenceId: occ.id, eventId: eventId.current,
        occurredAt: resolveWhen(when).toISOString(),
        ...(a !== null ? { amount: a } : {}), ...(a !== null && med.unit ? { unit: med.unit } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.show(r.alreadyCompleted ? 'すでに記録済みでした' : '飲ませた記録を保存しました');
      onClose();
    } catch (e) { setErr(apiErrorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={`${med.name}を飲ませた`} footer={<Button variant="primary" block onClick={submit} loading={busy} disabled={!online}>飲ませたと記録する</Button>}>
      <div className="stack">
        {last && <Card tone="warning"><strong>直近の実績: {formatElapsed(last.occurredAt)}（{memberName(last.caregiverUid)}）</strong><p className="small">二重に飲ませていないか、相手に確認してから記録してください。</p></Card>}
        <p className="small">指示（転記）: {med.instructionText}</p>
        <WhenField value={when} onChange={setWhen} label="飲ませた時刻" />
        <Field label={`実際の量${med.unit ? `（${med.unit}）` : ''}`} optional hint="実際に飲ませた量。アプリは量を計算しません">
          {({ id }) => <TextInput id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="メモ" optional>{({ id }) => <TextInput id={id} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {err && <div className="small ch-field__error" role="alert">{err}</div>}
        {!online && <p className="small muted">オフラインのため確定できません。</p>}
      </div>
    </Sheet>
  );
}

function MedSheet({ med, onClose }: { med: Med | null; onClose: () => void }) {
  const { familyId, childId } = useIds();
  const toast = useToast();
  const saver = useSaver();
  const [f, setF] = useState({
    name: med?.name ?? '', instruction: med?.instructionText ?? '', amount: med?.amount !== undefined ? String(med.amount) : '', unit: med?.unit ?? '',
    source: med?.instructionSource ?? '', start: med?.startDate ?? '', end: med?.endDate ?? '', asNeeded: med?.asNeeded ?? false,
  });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const amt = parseNum(f.amount);
  const bad = !f.name.trim() || !f.instruction.trim() || !f.source.trim() || (f.amount.trim() !== '' && (amt === null || amt < 0)) || (f.start && f.end && f.end < f.start);

  const submit = async (ended?: boolean) => {
    setTouched(true);
    if (bad || !familyId || !childId) return;
    setErr('');
    if (!med) {
      setBusy(true);
      try {
        await createFamilyDoc(paths.medications(familyId, childId).path, {
          name: f.name.trim(), instructionText: f.instruction.trim(), instructionSource: f.source.trim(), asNeeded: f.asNeeded, status: 'active',
          amount: amt ?? undefined, unit: f.unit.trim() || undefined, startDate: f.start || undefined, endDate: f.end || undefined,
        });
        toast.show('薬を登録しました'); onClose();
      } catch (e) { setErr(apiErrorMessage(e)); } finally { setBusy(false); }
      return;
    }
    const ok = await saver.save('medication', med.id, med.revision, {
      name: f.name.trim(), instructionText: f.instruction.trim(), instructionSource: f.source.trim(), asNeeded: f.asNeeded,
      amount: amt, unit: f.unit.trim() || null, startDate: f.start || null, endDate: f.end || null,
      status: ended === undefined ? med.status : ended ? 'ended' : 'active',
    });
    if (ok) { toast.show('保存しました'); onClose(); }
  };
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const e = (cond: boolean, m: string) => (touched && cond ? m : undefined);
  return (
    <Sheet open onClose={onClose} title={med ? '薬の登録内容' : '薬を登録'} footer={<Button variant="primary" block onClick={() => submit()} loading={busy || saver.saving}>保存</Button>}>
      <div className="stack">
        <p className="small muted">処方箋・説明書・医師や薬剤師の指示を、そのまま転記してください。量や回数はアプリが提案・計算しません。</p>
        {saver.conflict && <ConflictNotice onShowLatest={() => { saver.clear(); onClose(); }} onRetry={() => submit()} />}
        <Field label="薬の名称" error={e(!f.name.trim(), '入力してください')}>{({ id }) => <TextInput id={id} maxLength={200} value={f.name} onChange={(ev) => set({ name: ev.target.value })} />}</Field>
        <Field label="指示（処方どおりに転記）" error={e(!f.instruction.trim(), '入力してください')}>{({ id }) => <TextArea id={id} maxLength={2000} value={f.instruction} onChange={(ev) => set({ instruction: ev.target.value })} placeholder="例: 1日3回 食後に1包" />}</Field>
        <div className="hl-grid2">
          <Field label="指示の量" optional error={e(f.amount.trim() !== '' && (amt === null || amt < 0), '数字で入力')}>{({ id }) => <TextInput id={id} inputMode="decimal" value={f.amount} onChange={(ev) => set({ amount: ev.target.value })} />}</Field>
          <Field label="単位" optional>{({ id }) => <TextInput id={id} maxLength={20} value={f.unit} onChange={(ev) => set({ unit: ev.target.value })} placeholder="包／mL／錠" />}</Field>
        </div>
        <Field label="指示の出所" error={e(!f.source.trim(), '入力してください')} hint="例: ○○小児科の処方、薬局の説明書">{({ id }) => <TextInput id={id} maxLength={200} value={f.source} onChange={(ev) => set({ source: ev.target.value })} />}</Field>
        <div className="hl-grid2">
          <Field label="開始日" optional>{({ id }) => <TextInput id={id} type="date" value={f.start} onChange={(ev) => set({ start: ev.target.value })} />}</Field>
          <Field label="終了日" optional error={e(!!(f.start && f.end && f.end < f.start), '開始日より後にしてください')}>{({ id }) => <TextInput id={id} type="date" value={f.end} onChange={(ev) => set({ end: ev.target.value })} />}</Field>
        </div>
        <label className="row"><input type="checkbox" checked={f.asNeeded} onChange={(ev) => set({ asNeeded: ev.target.checked })} /> 頓服（必要なときに使う指示の薬）</label>
        {err && <div className="small ch-field__error" role="alert">{err}</div>}
        {saver.error && <div className="small ch-field__error" role="alert">{saver.error}</div>}
        {med && (med.status === 'active'
          ? <Button variant="danger" onClick={() => submit(true)}>この薬を終了にする</Button>
          : <Button onClick={() => submit(false)}>有効に戻す</Button>)}
      </div>
    </Sheet>
  );
}
