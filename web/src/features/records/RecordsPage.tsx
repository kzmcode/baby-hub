import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Card, DateNav, EmptyState, Select, Tabs } from '../../components';
import { useFamily } from '../../context';
import { useSyncStatus } from '../../lib/sync';
import { addDaysStr, dayRange, formatDateJa, formatDuration, todayStr } from '../../lib/time';
import { EventRow } from './EventRow';
import { RecordedBar } from './RecordedBar';
import { RecordSheet, type RecordSheetType } from './RecordSheet';
import { RoutineChart, RoutineLegend } from './RoutineChart';
import { SummaryCard } from './SummaryCard';
import { useEventsRange } from './hooks';
import { summarizeDay } from './logic/aggregate';
import { buildDayRoutine } from './logic/routine';
import { SLEEP_REASON_TEXT } from './logic/sleep';
import type { Ev } from './logic/types';
import { useNow } from './useNow';
import './records.css';

type View = 'list' | 'day' | 'week';
const GROUPS: { key: string; label: string; types: string[] }[] = [
  { key: 'feeding', label: '授乳・搾乳', types: ['feeding', 'pumping'] },
  { key: 'diaper', label: 'おむつ', types: ['diaper'] },
  { key: 'sleep', label: '睡眠', types: ['sleep_start', 'sleep_end'] },
  { key: 'vomit', label: '吐いた', types: ['vomit'] },
  { key: 'bath', label: '沐浴', types: ['bath'] },
  { key: 'other', label: 'その他', types: ['memo'] },
  { key: 'health', label: '健康', types: ['temperature', 'symptom', 'growth', 'medication_taken', 'meal', 'milestone'] },
];
const ZOOMS: { key: string; label: string; from: number; to: number }[] = [
  { key: 'all', label: '全体', from: 0, to: 24 },
  { key: 'z0', label: '0〜6時', from: 0, to: 6 },
  { key: 'z1', label: '6〜12時', from: 6, to: 12 },
  { key: 'z2', label: '12〜18時', from: 12, to: 18 },
  { key: 'z3', label: '18〜24時', from: 18, to: 24 },
];
const shortDate = (d: string) => formatDateJa(d).replace('月', '/').replace('日', '');

export function RecordsPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const { activeMembers } = useFamily();
  const { online } = useSyncStatus();
  const now = useNow(60000);
  const today = todayStr(now);

  const view = (sp.get('view') as View) || 'list';
  const date = sp.get('date') || today;
  const caregiver = sp.get('who') || 'all'; // all | none | uid
  const groups = useMemo(() => (sp.get('types') ? sp.get('types')!.split(',') : []), [sp]);
  const [zoom, setZoom] = useState('all');
  const [sheet, setSheet] = useState<RecordSheetType | null>(null);

  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) (v == null ? n.delete(k) : n.set(k, v));
    setSp(n, { replace: true });
  };

  const range = view === 'week' ? { s: addDaysStr(date, -6), e: date } : { s: date, e: date };
  const { start, end } = useMemo(() => ({ start: dayRange(range.s).start, end: dayRange(range.e).end }), [range.s, range.e]);
  const { events, sessions, loading, error, fromCache } = useEventsRange(start, end, 1, 1);

  const typeSet = useMemo(() => new Set(groups.flatMap((g) => GROUPS.find((x) => x.key === g)?.types ?? [])), [groups]);
  const pass = (e: Ev) =>
    (typeSet.size === 0 || typeSet.has(e.type)) &&
    (caregiver === 'all' || (caregiver === 'none' ? !e.caregiverUid : e.caregiverUid === caregiver));
  const sleepVisible = typeSet.size === 0 || typeSet.has('sleep_start');
  // 睡眠の帯は実施者フィルタでは壊さない（種別で睡眠を外したときだけ隠す）
  const bandSessions = sleepVisible ? sessions : [];

  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = range.s; d <= range.e; d = addDaysStr(d, 1)) out.push(d);
    return out;
  }, [range.s, range.e]);
  const routines = useMemo(() => days.map((d) => buildDayRoutine(events, bandSessions, d, now, pass)), [days, events, bandSessions, now, caregiver, typeSet]); // eslint-disable-line react-hooks/exhaustive-deps

  const dayEvents = useMemo(() => {
    const { start: s, end: e } = dayRange(date);
    return events.filter((x) => x.occurredAt >= s && x.occurredAt < e && pass(x)).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  }, [events, date, caregiver, typeSet]); // eslint-disable-line react-hooks/exhaustive-deps

  const sleepDur = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) if (s.state === 'closed' && s.start && s.end && s.endEventId) m.set(s.endEventId, `睡眠 ${formatDuration((s.end.getTime() - s.start.getTime()) / 1000)}`);
    return m;
  }, [sessions]);
  const conflictSessions = sessions.filter((s) => s.state === 'conflict');
  const summary = summarizeDay(events, sessions, date, now);

  const zoomDef = ZOOMS.find((z) => z.key === zoom) ?? ZOOMS[0];
  const toggleGroup = (k: string) => set({ types: (groups.includes(k) ? groups.filter((g) => g !== k) : [...groups, k]).join(',') || null });

  return (
    <div className="page rec-records">
      <Tabs
        ariaLabel="表示切替"
        value={view}
        onChange={(v) => set({ view: v === 'list' ? null : v })}
        tabs={[{ key: 'list', label: '一覧' }, { key: 'day', label: '24時間' }, { key: 'week', label: '7日' }]}
      />
      <DateNav date={date} onChange={(d) => set({ date: d === today ? null : d })} disableFuture />
      {view === 'week' && (
        <div className="row">
          <Button variant="ghost" onClick={() => set({ date: addDaysStr(date, -7) })}>前の7日</Button>
          <Button variant="ghost" onClick={() => set({ date: addDaysStr(date, 7) > today ? null : addDaysStr(date, 7) })} disabled={date >= today}>次の7日</Button>
          <span className="small muted">{shortDate(range.s)} 〜 {shortDate(range.e)}</span>
        </div>
      )}

      <Card className="rec-filters">
        <div className="rec-chips" role="group" aria-label="種別で絞り込み">
          <button type="button" className={`rec-chip${groups.length === 0 ? ' is-active' : ''}`} aria-pressed={groups.length === 0} onClick={() => set({ types: null })}>すべて</button>
          {GROUPS.map((g) => (
            <button key={g.key} type="button" className={`rec-chip${groups.includes(g.key) ? ' is-active' : ''}`} aria-pressed={groups.includes(g.key)} onClick={() => toggleGroup(g.key)}>{g.label}</button>
          ))}
        </div>
        <label className="rec-who">
          <span className="small">実施者</span>
          <Select
            aria-label="実施者"
            value={caregiver}
            onChange={(v) => set({ who: v === 'all' ? null : v })}
            options={[{ value: 'all', label: 'みんな' }, ...activeMembers.map((m) => ({ value: m.uid, label: m.displayName })), { value: 'none', label: '実施者未確認' }]}
          />
        </label>
        <p className="small muted">取得済みの期間内で絞り込みます。交代・振返りのためで、お世話量の比較ではありません。</p>
      </Card>

      {!online && fromCache && <p className="small rec-warn-text">オフライン：キャッシュ表示です。最新ではない可能性があります。</p>}
      {error && <Card tone="danger" role="alert">記録を読み込めませんでした。通信を確認してください。</Card>}
      {conflictSessions.length > 0 && (
        <Card tone="warning">
          <strong>睡眠の記録に確認待ちがあります</strong>
          <ul className="small">
            {conflictSessions.map((s) => (
              <li key={s.sessionId}>{(s.start ?? s.end) && shortDate(todayStr((s.start ?? s.end)!))} {SLEEP_REASON_TEXT[s.reason!]}。該当の記録を訂正・無効化してください。</li>
            ))}
          </ul>
        </Card>
      )}

      {view !== 'week' && <SummaryCard s={summary} title={`${date === today ? '今日' : shortDate(date)}の集計`} />}

      {view !== 'list' && (
        <Card className="rec-routine-card" aria-label="時間帯ごとの記録">
          <div className="rec-zoom" role="group" aria-label="時間帯の拡大">
              {ZOOMS.map((z) => (
                <button key={z.key} type="button" className={`rec-chip${zoom === z.key ? ' is-active' : ''}`} aria-pressed={zoom === z.key} onClick={() => setZoom(z.key)}>{z.label}</button>
              ))}
          </div>
          {loading ? <p className="muted">読み込み中…</p> : (
            <RoutineChart
              rows={routines}
              fromHour={zoomDef.from}
              toHour={zoomDef.to}
              labelOf={shortDate}
              onRowClick={view === 'week' ? (d) => set({ view: 'day', date: d === today ? null : d }) : undefined}
              onMarkerClick={(id) => navigate(`/records/${id}`)}
            />
          )}
          <RoutineLegend />
          <p className="small muted">空白は未記録の時間で、お世話がなかったとは限りません。薄い部分はまだ来ていない時間です。点線は終了未記録、斜線は確認待ちの睡眠です。{view === 'week' && '日付の行を押すとその日の一覧を開きます。'}</p>
        </Card>
      )}

      {view === 'week' && (
        <Card>
          <h2 className="rec-h2">日ごとの要点</h2>
          <div className="rec-weektable" role="table" aria-label="日ごとの要点">
            {days.slice().reverse().map((d) => {
              const s = summarizeDay(events, sessions, d, now);
              return (
                <button key={d} type="button" role="row" className="rec-weekrow" onClick={() => set({ view: 'day', date: d === today ? null : d })}>
                  <strong>{shortDate(d)}</strong>
                  <span>哺乳 {s.breastCount + s.formulaCount + s.expressedCount}回{s.milkMl > 0 ? ` / ${s.milkMl}mL` : ''}{s.milkUnknownCount > 0 ? `（量未入力${s.milkUnknownCount}）` : ''}</span>
                  <span>尿 {s.urineCount} 便 {s.stoolCount} 吐 {s.vomitCount} 浴 {s.bathCount}</span>
                  <span>睡眠 {formatDuration(s.sleepConfirmedSeconds)}{s.sleepOpenSeconds > 0 ? ' +未終了' : ''}</span>
                </button>
              );
            })}
          </div>
        </Card>
      )}

      {view !== 'week' && (
        <section className="stack" aria-label="記録一覧">
          <div className="rec-list-head"><h2 className="rec-h2">{date === today ? '今日' : shortDate(date)}の記録</h2><label className="rec-add"><span className="sr-only">記録を追加</span>
            <Select value="" onChange={(v) => v && setSheet(v as RecordSheetType)} aria-label="記録を追加"
              options={[{ value: '', label: '＋ 記録を追加' }, { value: 'feeding', label: '授乳・ミルク' }, { value: 'diaper', label: 'おむつ' }, { value: 'sleep', label: '寝た／起きた' }, { value: 'vomit', label: '吐いた' }, { value: 'bath', label: '沐浴' }, { value: 'other', label: 'その他' }]} /></label></div>
          {loading ? <p className="muted">読み込み中…</p> : dayEvents.length === 0 ? (
            <EmptyState title="この条件の記録はありません" description="未記録の日は、何もしていない日という意味ではありません。" icon="records" />
          ) : (
            dayEvents.map((e) => <EventRow key={e.id} ev={e} tag={sleepDur.get(e.id)} />)
          )}
        </section>
      )}
      <RecordedBar />
      {sheet && <RecordSheet open type={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
