// 受診用表示・印刷（S10）。記録された情報のみ。評価や診断はしない
import { useMemo, useState } from 'react';
import { useFamily } from '../../context';
import { paths, useCollection } from '../../lib/db';
import { dayRange, formatDateJa, formatDuration, formatTime, rangeOfDays, todayStr, toDateStr, formatAge } from '../../lib/time';
import { Button, Card, EmptyState, Field, TextInput } from '../../components';
import { PageHeader, toLogEvent, useEventsBetween, useIds } from './shared';
import { dateRange, lastNDays, summarizeByDay, type LogEvent } from './logic/summary';
import type { Medication } from '../../types/models';

const TYPE_LABEL: Record<string, string> = {
  temperature: '体温', symptom: '症状（保護者の観察）', vomit: '吐いた', feeding: '授乳', diaper: 'おむつ', sleep_start: '寝た', sleep_end: '起きた', medication_taken: '薬を飲ませた',
};
const METHOD: Record<string, string> = { breast: '母乳', formula: 'ミルク', expressed_breast_milk: '搾母乳' };
const AMOUNT: Record<string, string> = { small: '少量', medium: '中程度', large: '多め', unknown: '量不明' };
const YN: Record<string, string> = { yes: 'あり', no: 'なし', unknown: '未確認' };
const TYPES = new Set(Object.keys(TYPE_LABEL));

export function describe(e: LogEvent, medName: (id: string) => string): string {
  const p = e.payload;
  switch (e.type) {
    case 'temperature': return `${p.celsius}℃`;
    case 'symptom': return `${((p.symptomTags as string[]) ?? []).join('、')}${p.observedText ? `／${p.observedText}` : ''}`;
    case 'vomit': return `${AMOUNT[String(p.amountCategory ?? 'unknown')] ?? '量不明'}${p.appearanceText ? `／${p.appearanceText}` : ''}`;
    case 'feeding': return `${METHOD[String(p.method)] ?? ''}${typeof p.consumedMl === 'number' ? ` ${p.consumedMl}mL` : ' 量未入力'}`;
    case 'diaper': return `尿:${YN[String(p.urine)] ?? '-'} 便:${YN[String(p.stool)] ?? '-'}${p.stoolNote ? `（${p.stoolNote}）` : ''}`;
    case 'medication_taken': return `${medName(String(p.medicationId))}${typeof p.amount === 'number' ? ` ${p.amount}${p.unit ?? ''}` : ''}`;
    default: return '';
  }
}

export function ReportPage() {
  const { childId } = useIds();
  const { child, memberName } = useFamily();
  const init = lastNDays(todayStr(), 3);
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const valid = from <= to && dateRange(from, to).length <= 31;
  const range = useMemo(() => (valid ? rangeOfDays(from, to) : dayRange(todayStr())), [from, to, valid]);
  const ev = useEventsBetween(range.start, range.end);
  const meds = useCollection<Medication>(useFamilyMedRef());
  const medName = (id: string) => meds.data.find((m) => m.id === id)?.name ?? '（不明な薬）';

  const logs = useMemo(() => ev.data.map(toLogEvent).filter((e) => TYPES.has(e.type)), [ev.data]);
  const dates = useMemo(() => (valid ? dateRange(from, to) : []), [from, to, valid]);
  const days = useMemo(() => summarizeByDay(ev.data.map(toLogEvent), dates, (d) => toDateStr(d), (s) => dayRange(s).start), [ev.data, dates]);
  const timeline = [...logs].reverse();
  const loadingAny = ev.loading;

  return (
    <div className="page">
      <div className="hl-noprint"><PageHeader title="受診用表示" /></div>
      <div className="hl-noprint stack">
        <div className="hl-grid2">
          <Field label="開始日">{({ id }) => <TextInput id={id} type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />}</Field>
          <Field label="終了日">{({ id }) => <TextInput id={id} type="date" value={to} min={from} max={todayStr()} onChange={(e) => e.target.value && setTo(e.target.value)} />}</Field>
        </div>
        <div className="row">
          {[1, 3, 7].map((n) => <Button key={n} onClick={() => { const r = lastNDays(todayStr(), n); setFrom(r.from); setTo(r.to); }}>直近{n}日</Button>)}
          <Button variant="primary" onClick={() => window.print()} disabled={!valid}>印刷する</Button>
        </div>
        {!valid && <div className="small ch-field__error" role="alert">開始日は終了日以前、期間は31日以内にしてください</div>}
      </div>

      <h1 className="hl-print-only">受診用の記録（{child?.nickname ?? ''}）</h1>
      <Card tone="warning">
        <p className="small"><strong>この表は、アプリに記録された情報のみをまとめたものです。</strong>未記録は「発生しなかった」ことを意味しません。診断や判断をするものではありません。</p>
        <p className="small">期間: {formatDateJa(from)} 〜 {formatDateJa(to)}　{child?.birthDate ? `月齢・年齢: ${formatAge(child.birthDate) ?? ''}` : ''}　出力: {toDateStr(new Date())} {formatTime(new Date())}</p>
      </Card>

      {loadingAny ? <p className="muted" role="status">読み込み中…</p> : !childId || !valid ? null : logs.length === 0 ? (
        <EmptyState title="この期間の記録はありません" description="記録がないことは、何も起きなかったことを意味しません。" />
      ) : (
        <>
          <Card>
            <h2>日別の集計</h2>
            <div className="hl-table-scroll" role="region" aria-label="日別の集計表" tabIndex={0}>
              <table className="hl-table">
                <thead><tr><th>日付</th><th>体温</th><th>吐いた</th><th>授乳</th><th>おむつ</th><th>睡眠(記録分)</th><th>薬</th></tr></thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.date}>
                      <td>{formatDateJa(d.date)}</td>
                      <td>{d.temperatures.length ? `${d.temperatures.length}回（最高 ${Math.max(...d.temperatures)}℃）` : '記録なし'}</td>
                      <td>{d.vomitCount}回</td>
                      <td>{d.feedingCount}回{d.feedingMl > 0 ? ` / ${d.feedingMl}mL` : ''}{d.feedingMlUnknownCount ? `（量未入力 ${d.feedingMlUnknownCount}件）` : ''}</td>
                      <td>{d.diaperCount}回（尿 {d.urineCount}／便 {d.stoolCount}）</td>
                      <td>{formatDuration(d.sleepSeconds)}{d.sleepOpen ? '＋終了未記録あり' : ''}</td>
                      <td>{d.medicationCount}回</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">授乳量は量が入力された記録の合計です。睡眠は開始と終了がそろった記録のみ、日付をまたぐ分は日ごとに分けています。</p>
          </Card>
          <Card>
            <h2>時系列</h2>
            <div className="hl-table-scroll" role="region" aria-label="時系列の記録表" tabIndex={0}>
              <table className="hl-table">
                <thead><tr><th>日時</th><th>種類</th><th>内容</th><th>実施者</th></tr></thead>
                <tbody>
                  {timeline.map((e) => (
                    <tr key={e.id}>
                      <td>{toDateStr(e.occurredAt).slice(5).replace('-', '/')} {formatTime(e.occurredAt)}</td>
                      <td>{TYPE_LABEL[e.type]}</td>
                      <td>{describe(e, medName)}{e.note ? `／${e.note}` : ''}</td>
                      <td>{memberName(e.caregiverUid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

import { query } from 'firebase/firestore';
function useFamilyMedRef() {
  const { familyId, childId } = useIds();
  return useMemo(() => (familyId && childId ? query(paths.medications(familyId, childId)) : null), [familyId, childId]);
}
