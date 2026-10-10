import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { query, where } from 'firebase/firestore';
import { limit, orderBy, Timestamp } from 'firebase/firestore';
import { Button, Card, CategoryIcon, EmptyState, SegmentedControl, SyncBadge, syncStateOf, useToast } from '../../components';
import { useFamily } from '../../context';
import { api, apiErrorMessage, toApiError } from '../../lib/api';
import { paths, useCollection, useDocument } from '../../lib/db';
import { dayRange, formatDateJa, formatElapsed, formatTime } from '../../lib/time';
import type { DailyEvent } from '../../types/models';
import { EventRow } from './EventRow';
import { RecordSheet, sheetTypeOf } from './RecordSheet';
import { useEventsRange } from './hooks';
import { amountText, categoryOf, describeEvent, feedingLabel, whoText } from './logic/describe';
import { buildReflection } from './logic/reflection';
import { toEv, type Ev, type EventDoc } from './logic/types';
import './records.css';

type Win = 'default' | '1h' | '3h' | '6h' | 'day';
const WINDOWS: Record<Exclude<Win, 'day'>, { before: number; after: number }> = {
  default: { before: 360, after: 180 },
  '1h': { before: 60, after: 60 },
  '3h': { before: 180, after: 180 },
  '6h': { before: 360, after: 360 },
};

const fmtDT = (d: Date) => `${formatDateJa(toLocalDate(d))} ${formatTime(d)}`;
const relText = (from: Date, target: Date) => {
  const m = Math.round((from.getTime() - target.getTime()) / 60000);
  const abs = Math.abs(m);
  const t = abs < 60 ? `${abs}分` : `${Math.floor(abs / 60)}時間${abs % 60 ? `${abs % 60}分` : ''}`;
  return m === 0 ? '同時刻' : m < 0 ? `対象の${t}前` : `対象の${t}後`;
};

export function EventDetailPage() {
  const { eventId } = useParams();
  const { familyId, childId, child, memberName } = useFamily();
  const navigate = useNavigate();
  const toast = useToast();
  const doc = useDocument<DailyEvent>(familyId && childId && eventId ? paths.event(familyId, childId, eventId) : null);
  const ev = useMemo(() => (doc.data ? toEv(doc.data as EventDoc) : null), [doc.data]);
  const raw = doc.data;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [win, setWin] = useState<Win>('default');

  if (doc.loading) return <div className="page"><p className="muted" role="status">読み込み中…</p></div>;
  if (!ev || !raw) {
    return (
      <div className="page">
        <EmptyState title="この記録は見つかりません" description="削除されたか、読み込めませんでした。" icon="alert" action={<Button onClick={() => navigate('/records')}>記録一覧へ</Button>} />
      </div>
    );
  }
  const d = describeEvent(ev);
  const cat = categoryOf(ev.type);
  const sheetType = sheetTypeOf(ev);
  const isVoid = ev.status === 'void';

  async function setStatus(status: 'active' | 'void') {
    if (!familyId || !childId || !ev) return;
    if (status === 'void' && !window.confirm('この記録を無効化しますか？一覧・集計・ホームから外れます（あとで戻せます）。')) return;
    setBusy(true);
    try {
      await api.setEventStatus({ familyId, childId, eventId: ev.id, expectedRevision: ev.revision, status });
      toast.show(status === 'void' ? '無効化しました' : '戻しました');
    } catch (e) {
      toast.show(toApiError(e).isConflict ? '他の人が先に更新しました。内容を確認してからやり直してください。' : apiErrorMessage(e), { tone: 'error' });
    } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <div className="row">
        <Button variant="ghost" onClick={() => navigate(-1)}><CategoryIcon name="chevronLeft" size={18} /> 戻る</Button>
        <span className="spacer" />
        <SyncBadge state={syncStateOf({ pending: ev.pending })} />
      </div>

      <Card style={{ background: `var(--cat-${cat}-bg)`, color: `var(--cat-${cat}-fg)` }}>
        <div className="row">
          <CategoryIcon name={cat} size={32} />
          <div>
            <h1 className="rec-h1">{d.title}</h1>
            {d.detail && <div>{d.detail}</div>}
          </div>
        </div>
        {isVoid && <p role="status"><strong>この記録は無効化されています</strong>（一覧・集計には含まれません）</p>}
      </Card>

      <Card>
        <dl className="rec-sum">
          <dt>対象</dt><dd>{child?.nickname}</dd>
          <dt>実施時刻</dt><dd className="num">{fmtDT(ev.occurredAt)}</dd>
          {ev.endedAt && (<><dt>終了</dt><dd className="num">{fmtDT(ev.endedAt)}</dd></>)}
          <dt>実施者</dt><dd>{ev.caregiverUid ? memberName(ev.caregiverUid) : '実施者未確認'}</dd>
          <dt>入力者</dt><dd>{memberName(ev.createdBy)}</dd>
          {ev.note && (<><dt>メモ</dt><dd className="rec-pre">{ev.note}</dd></>)}
          <dt>記録の版</dt><dd>r{ev.revision}{ev.revision > 1 ? '（訂正あり）' : ''}</dd>
        </dl>
        {ev.pending && <p className="small rec-warn-text">未同期です。共有されるまで訂正・無効化はできません。</p>}
        <div className="row">
          {sheetType ? (
            <Button variant="primary" disabled={ev.pending || isVoid} onClick={() => setEditing(true)}>時刻・実施者などを訂正</Button>
          ) : (
            <p className="small muted">この種類の記録は、健康画面から訂正できます。</p>
          )}
          {isVoid ? (
            <Button disabled={ev.pending} loading={busy} onClick={() => void setStatus('active')}>戻す</Button>
          ) : (
            <Button variant="danger" disabled={ev.pending} loading={busy} onClick={() => void setStatus('void')}>無効化</Button>
          )}
        </div>
      </Card>

      <History eventId={ev.id} />
      {!isVoid && <Reflection ev={ev} win={win} setWin={setWin} />}
      <LinkedSection ev={ev} />

      {sheetType && editing && <RecordSheet open type={sheetType} initialEvent={ev} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** 訂正履歴（監査ログから対象IDで取得。取得できない場合は版情報のみ） */
function History({ eventId }: { eventId: string }) {
  const { familyId, memberName } = useFamily();
  const q = useMemo(() => (familyId ? query(paths.auditLogs(familyId), where('target.id', '==', eventId)) : null), [familyId, eventId]);
  const { data, error } = useCollection<{ action: string; actorUid: string; at: Timestamp }>(q);
  const rows = [...data].filter((r) => r.at?.toDate).sort((a, b) => b.at.toDate().getTime() - a.at.toDate().getTime());
  const label = (a: string) => (a.includes('void') ? '無効にした' : a.includes('restore') ? '有効に戻した' : a.includes('status') ? '有効／無効の変更' : a.includes('update') ? '訂正' : a.includes('create') ? '作成' : a);
  return (
    <Card aria-label="訂正履歴">
      <h2 className="rec-h2">訂正履歴</h2>
      {error || rows.length === 0 ? (
        <p className="small muted">{error ? '履歴を読み込めませんでした。' : '訂正の履歴はありません。'}</p>
      ) : (
        <ul className="rec-hist">
          {rows.map((r) => (
            <li key={r.id}><span className="num">{fmtDT(r.at.toDate())}</span> {memberName(r.actorUid)}が{label(r.action)}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Reflection({ ev, win, setWin }: { ev: Ev; win: Win; setWin: (w: Win) => void }) {
  const { familyId, childId, memberName } = useFamily();
  const toast = useToast();
  const range = useMemo(() => {
    if (win === 'day') {
      const r = dayRange(toLocalDate(ev.occurredAt));
      return { start: r.start, end: r.end, before: (ev.occurredAt.getTime() - r.start.getTime()) / 60000, after: (r.end.getTime() - ev.occurredAt.getTime()) / 60000 };
    }
    const w = WINDOWS[win];
    return { start: new Date(ev.occurredAt.getTime() - w.before * 60000), end: new Date(ev.occurredAt.getTime() + w.after * 60000 + 1), before: w.before, after: w.after };
  }, [win, ev.occurredAt]);
  const { events, loading } = useEventsRange(range.start, range.end, 0, 0);
  // 直前の哺乳（範囲外でも取得）: type+status+occurredAt 降順
  const prevQ = useMemo(
    () => familyId && childId
      ? query(paths.events(familyId, childId), where('type', '==', 'feeding'), where('status', '==', 'active'), where('occurredAt', '<=', Timestamp.fromDate(ev.occurredAt)), orderBy('occurredAt', 'desc'), limit(2))
      : null,
    [familyId, childId, ev.occurredAt],
  );
  const prev = useCollection<DailyEvent>(prevQ);
  const candidates = useMemo(() => {
    const m = new Map<string, Ev>();
    for (const e of events) m.set(e.id, e);
    for (const p of prev.data) m.set(p.id, toEv(p as EventDoc));
    return [...m.values()];
  }, [events, prev.data]);
  const target = ev;
  const before = range.before;
  const after = range.after;
  const r = useMemo(() => buildReflection(target, candidates, before, after), [target, candidates, before, after]);
  const linked = new Set(ev.contextEventIds ?? []);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggle(id: string) {
    if (!familyId || !childId) return;
    const next = linked.has(id) ? [...linked].filter((x) => x !== id) : [...linked, id];
    if (next.length > 20) { toast.show('関連として残せるのは20件までです', { tone: 'error' }); return; }
    setBusyId(id);
    try {
      await api.updateEvent({ familyId, childId, eventId: ev.id, expectedRevision: ev.revision, patch: { contextEventIds: next } });
      toast.show(linked.has(id) ? '関連を外しました' : '関連として残しました');
    } catch (e) {
      toast.show(apiErrorMessage(e), { tone: 'error' });
    } finally { setBusyId(null); }
  }

  const prevFeed = r.previousFeeding;
  return (
    <Card aria-label="前後の記録">
      <h2 className="rec-h2">前後の記録</h2>
      <p className="small muted">時間の前後関係を並べたものです。原因や医学的な判断を示すものではありません。</p>
      <SegmentedControl<Win>
        ariaLabel="前後の範囲"
        value={win}
        onChange={setWin}
        options={[
          { value: 'default', label: '前6時間・後3時間' },
          { value: '1h', label: '前後1時間' },
          { value: '3h', label: '前後3時間' },
          { value: '6h', label: '前後6時間' },
          { value: 'day', label: '当日' },
        ]}
      />
      <div className="rec-prevfeed" aria-label="直前の哺乳">
        <strong>直前の哺乳</strong>
        {prevFeed ? (
          <div>
            <span className="num">{formatTime(prevFeed.occurredAt)}</span> {feedingLabel(prevFeed)}
            {amountText(prevFeed) ? `・${amountText(prevFeed)}` : ''}・{formatElapsed(prevFeed.occurredAt, ev.occurredAt)}（対象の{r.minutesSincePreviousFeeding}分前）・{whoText(prevFeed, memberName)}
            {r.previousFeedingOutOfRange && <span className="rec-row__tag">範囲外の直前の哺乳</span>}
          </div>
        ) : (
          <div className="muted small">{loading || prev.loading ? '確認中…' : '対象より前の哺乳の記録は見つかりません（未記録の可能性があります）'}</div>
        )}
      </div>
      <div className="stack">
        {r.inRange.map((e) => {
          const isTarget = e.id === ev.id;
          return (
            <div key={e.id} className="rec-ctx">
              <EventRow ev={e} highlight={isTarget} tag={isTarget ? '対象' : relText(e.occurredAt, ev.occurredAt)} />
              {!isTarget && (
                <Button
                  variant={linked.has(e.id) ? 'primary' : 'secondary'}
                  loading={busyId === e.id}
                  disabled={ev.pending}
                  onClick={() => void toggle(e.id)}
                  aria-pressed={linked.has(e.id)}
                >
                  {linked.has(e.id) ? '関連として保存済み（外す）' : '関連として残す'}
                </Button>
              )}
            </div>
          );
        })}
        {prevFeed && r.previousFeedingOutOfRange && (
          <div className="rec-ctx">
            <EventRow ev={prevFeed} tag="範囲外の直前の哺乳" />
            <Button variant={linked.has(prevFeed.id) ? 'primary' : 'secondary'} loading={busyId === prevFeed.id} disabled={ev.pending} onClick={() => void toggle(prevFeed.id)}>
              {linked.has(prevFeed.id) ? '関連として保存済み（外す）' : '関連として残す'}
            </Button>
          </div>
        )}
      </div>
      <p className="small muted">「関連として残す」はあなたが選んだ振返り用のメモで、因果関係の認定ではありません。</p>
    </Card>
  );
}

function toLocalDate(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(d);
}

function LinkedSection({ ev }: { ev: Ev }) {
  const ids = ev.contextEventIds ?? [];
  if (ids.length === 0) return null;
  return (
    <Card aria-label="関連として残した記録">
      <h2 className="rec-h2">関連として残した記録</h2>
      <div className="stack">{ids.map((id) => <LinkedRow key={id} id={id} />)}</div>
      <p className="small muted">リンクは文脈の記録であり、原因を示すものではありません。</p>
    </Card>
  );
}

function LinkedRow({ id }: { id: string }) {
  const { familyId, childId } = useFamily();
  const doc = useDocument<DailyEvent>(familyId && childId ? paths.event(familyId, childId, id) : null);
  if (doc.loading) return <p className="muted small">読み込み中…</p>;
  if (!doc.data) return <p className="muted small">関連記録は削除済みです</p>;
  const e = toEv(doc.data as EventDoc);
  if (e.status === 'void') return <p className="muted small">関連記録は無効化されています（<Link to={`/records/${id}`}>開く</Link>）</p>;
  return <EventRow ev={e} showDate />;
}
