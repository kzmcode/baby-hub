import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, CategoryIcon, CategoryTile, EmptyState, Sheet, type CategoryName } from '../../components';
import { useAuth, useFamily, useUserSettings } from '../../context';
import { addDaysStr, dayRange, formatDuration, formatElapsed, formatTime, todayStr } from '../../lib/time';
import type { HomeItemKey, QuickRecordKey } from '../../types/models';
import { HomeHandoversCard, HomeShoppingCard, HomeTodayPlansCard } from '../plans';
import { EventRow } from './EventRow';
import { HomeRhythm } from './HomeRhythm';
import { RecordedBar } from './RecordedBar';
import { RecordSheet, type RecordSheetType } from './RecordSheet';
import { useEventsRange, useLatestOfType } from './hooks';
import { amountText, feedingLabel, whoText } from './logic/describe';
import { buildDayRoutine } from './logic/routine';
import { SLEEP_REASON_TEXT, currentSleepState } from './logic/sleep';
import { useNow } from './useNow';
import { useRecorder } from './recorder';
import './records.css';

const TILE: Record<QuickRecordKey, { cat: CategoryName; label: string }> = {
  diaper: { cat: 'diaper', label: 'おむつ' },
  feeding: { cat: 'feeding', label: '授乳・ミルク' },
  vomit: { cat: 'vomit', label: '吐いた' },
  sleep: { cat: 'sleep', label: '寝た' },
  bath: { cat: 'bath', label: '沐浴' },
  other: { cat: 'other', label: 'その他' },
};
const DEFAULT_ORDER: HomeItemKey[] = ['status', 'recent', 'quickRecord', 'todayRhythm', 'handovers', 'todayPlans', 'shopping'];

export function HomePage() {
  const { memberName } = useFamily();
  const { user } = useAuth();
  const { settings } = useUserSettings();
  const now = useNow();
  const { record } = useRecorder();

  const today = todayStr(now);
  const yesterday = addDaysStr(today, -1);
  const winEnd = dayRange(today).end;
  const { events, sessions, loading } = useEventsRange(dayRange(yesterday).start, winEnd, 1, 0);
  const lastFeed = useLatestOfType('feeding');
  const lastDiaper = useLatestOfType('diaper');
  const sleep = useMemo(() => currentSleepState(sessions), [sessions]);

  const [sheet, setSheet] = useState<RecordSheetType | null>(null);
  const [chooser, setChooser] = useState(false);

  function quickVomit() {
    record({ type: 'vomit', occurredAt: new Date(), caregiverUid: user?.uid ?? null, payload: {} }, '吐いた');
  }
  function quickBath() {
    record({ type: 'bath', occurredAt: new Date(), caregiverUid: user?.uid ?? null, payload: {} }, '沐浴');
  }
  function quickSleep() {
    if (sleep.kind === 'unconfirmed') return setSheet('sleep');
    const at = new Date();
    if (sleep.kind === 'sleeping') {
      const s = sleep.session;
      record({ type: 'sleep_end', occurredAt: at, caregiverUid: user?.uid ?? null, sessionId: s.sessionId, payload: { sessionId: s.sessionId, startEventId: s.startEventId! } }, '起きた');
    } else {
      const sessionId = crypto.randomUUID();
      record({ type: 'sleep_start', occurredAt: at, caregiverUid: user?.uid ?? null, sessionId, payload: { sessionId } }, '寝た');
    }
  }

  const recent = useMemo(() => [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, 5), [events]);
  const rhythm = useMemo(
    () => buildDayRoutine(events, sessions, today, now),
    [events, sessions, today, now],
  );

  const items = (settings.homeItems?.length ? settings.homeItems : DEFAULT_ORDER.map((key) => ({ key, visible: true }))).filter((i) => i.visible);
  const quickTypes = (settings.quickRecordTypes?.length ? settings.quickRecordTypes : (Object.keys(TILE) as QuickRecordKey[]));

  function render(key: HomeItemKey) {
    switch (key) {
      case 'status':
        return (
          <section key={key} className="stack" aria-label="いまの状態">
            <Card className="rec-status">
              <div className={`rec-sleepcard rec-sleepcard--${sleep.kind}`}>
                <span className="rec-sleepcard__icon"><CategoryIcon name={sleep.kind === 'awake' ? 'sun' : sleep.kind === 'unconfirmed' ? 'alert' : 'sleep'} size={40} strokeWidth={1.5} /></span>
                <div className="rec-sleepcard__text">
                  {sleep.kind === 'sleeping' && (<>
                    <strong className="rec-big">記録上は睡眠中</strong>
                    <span className="small">{formatTime(sleep.since)} から（経過 {formatDuration((now.getTime() - sleep.since.getTime()) / 1000)}）</span>
                  </>)}
                  {sleep.kind === 'awake' && (<>
                    <strong className="rec-big">起きている</strong>
                    <span className="small">{sleep.lastWake ? `最終起床 ${formatTime(sleep.lastWake)}（${formatElapsed(sleep.lastWake, now)}）` : '直近の睡眠記録はありません'}</span>
                  </>)}
                  {sleep.kind === 'unconfirmed' && (<>
                    <strong className="rec-big">睡眠：確認待ち</strong>
                    <span className="small">{SLEEP_REASON_TEXT[sleep.sessions[0].reason!]}。<Link to="/records">記録を確認</Link></span>
                  </>)}
                </div>
              </div>
              <div className="rec-now" aria-label="現在時刻">
                <span className="small">いま</span>
                <strong className="num">{formatTime(now)}</strong>
              </div>
            </Card>
          </section>
        );
      case 'quickRecord':
        return (
          <section key={key} aria-label="記録する">
            <div className="rec-tiles">
              {quickTypes.map((k) => {
                const t = TILE[k];
                if (!t) return null;
                if (k === 'sleep') {
                  const label = sleep.kind === 'sleeping' ? '起きた' : sleep.kind === 'unconfirmed' ? '睡眠を確認' : '寝た';
                  return <CategoryTile key={k} category="sleep" icon={sleep.kind === 'sleeping' ? 'sun' : sleep.kind === 'unconfirmed' ? 'alert' : undefined} label={label} onClick={quickSleep} disabled={loading} />;
                }
                const click = k === 'vomit' ? quickVomit : k === 'bath' ? quickBath : () => setSheet(k as RecordSheetType);
                return <CategoryTile key={k} category={t.cat} label={t.label} onClick={click} />;
              })}
            </div>
            <div className="row rec-tiles__more">
              <Button variant="ghost" onClick={() => setChooser(true)}>時刻・実施者を指定して記録</Button>
            </div>
          </section>
        );
      case 'todayRhythm':
        return (
          <Card key={key} aria-label="今日のリズム" className="rec-rhythm-card">
            <div className="rec-cardhead">
              <h2 className="rec-h2">今日のリズム</h2>
              <span className="spacer" />
              <Link to="/records?view=week" className="rec-link rec-link--accent">7日をみる <CategoryIcon name="chevronRight" size={16} /></Link>
            </div>
            <HomeRhythm routine={rhythm} />
            <p className="rec-rhythm-note">空白は未記録。睡眠の点線は終了未記録です。</p>
          </Card>
        );
      case 'recent':
        return (
          <Card key={key} aria-label="直近の記録" className="rec-recent">
            <div className="rec-cardhead"><h2 className="rec-h2">最近の記録</h2><span className="spacer" /><Link to="/records" className="rec-link">すべてみる <CategoryIcon name="chevronRight" size={16} /></Link></div>
            {recent.length === 0 ? (
              <EmptyState title="まだ記録がありません" description="お世話ボタンから、今日のひとつを。" icon="records" />
            ) : (
              <div className="rec-list">{recent.slice(0, 2).map((e) => <EventRow key={e.id} ev={e} compact />)}</div>
            )}
            <details className="rec-last-details">
              <summary>最後の授乳・おむつを確認</summary>
              <div className="rec-last">
                <LastCard label="最終哺乳" cat="feeding" ev={lastFeed.event} loading={lastFeed.loading} now={now} extra={(e) => `${feedingLabel(e)}${amountText(e) ? ` ${amountText(e)}` : ''}`} memberName={memberName} />
                <LastCard label="最終おむつ" cat="diaper" ev={lastDiaper.event} loading={lastDiaper.loading} now={now} extra={(e) => `尿:${yn(e.payload.urine)} 便:${yn(e.payload.stool)}`} memberName={memberName} />
              </div>
            </details>
          </Card>
        );
      case 'handovers': return <HomeHandoversCard key={key} />;
      case 'todayPlans': return <HomeTodayPlansCard key={key} />;
      case 'shopping': return <HomeShoppingCard key={key} />;
      default: return null;
    }
  }

  return (
    <div className="page rec-home">
      {items.map((i) => render(i.key))}
      <RecordedBar />
      {sheet && <RecordSheet open type={sheet} onClose={() => setSheet(null)} />}
      <Sheet open={chooser} onClose={() => setChooser(false)} title="記録の種類を選ぶ">
        <div className="rec-choices">
          {(Object.keys(TILE) as QuickRecordKey[]).map((k) => (
            <button key={k} type="button" className="rec-choice" onClick={() => { setChooser(false); setSheet(k as RecordSheetType); }}>
              {k === 'sleep' ? '寝た／起きた' : TILE[k].label}
            </button>
          ))}
        </div>
        <p className="small muted">吐いた・沐浴もここなら時刻と実施者を指定して保存できます。</p>
      </Sheet>
    </div>
  );
}

function yn(v: unknown) { return v === 'yes' ? 'あり' : v === 'no' ? 'なし' : '未確認'; }

function LastCard({ label, cat, ev, loading, now, extra, memberName }: {
  label: string; cat: CategoryName; ev: import('./logic/types').Ev | null; loading: boolean; now: Date;
  extra: (e: import('./logic/types').Ev) => string; memberName: (u?: string | null) => string;
}) {
  return (
    <Card className="rec-lastcard" style={{ background: `var(--cat-${cat}-bg)`, color: `var(--cat-${cat}-fg)` }}>
      <span className="rec-lastcard__icon"><CategoryIcon name={cat} size={22} /></span>
      <div className="rec-lastcard__body">
        <div className="small">{label}</div>
        {ev ? (
          <>
            <div className="rec-lastcard__time num"><Link to={`/records/${ev.id}`}>{formatTime(ev.occurredAt)}</Link> <span className="small">{formatElapsed(ev.occurredAt, now)}</span></div>
            <div className="small">{extra(ev)}</div>
            <div className="small">{whoText(ev, memberName)}</div>
          </>
        ) : (
          <div className="small">{loading ? '確認中…' : '記録なし'}</div>
        )}
      </div>
    </Card>
  );
}
