// 成長（身長・体重）。評価はしない
import { useMemo, useState } from 'react';
import { createEvent } from '../../lib/db';
import { Button, Card, EmptyState, Field, Sheet, TextInput, useToast } from '../../components';
import { useIds, useRecentEvents, PageHeader, WhenField, newWhen, resolveWhen, tsToDate, dateTimeText } from './shared';
import { gramsToKgText, kgToGrams, parseNum, validateGrowth } from './logic/units';
import { growthSeries } from './logic/summary';
import { formatDateJa, toDateStr } from '../../lib/time';
import type { EventPayloadMap } from '../../types/models';

function Chart({ points, label, unit }: { points: { t: number; v: number }[]; label: string; unit: string }) {
  if (points.length < 2) return <p className="small muted">{label}: 2件以上記録すると推移が表示されます。</p>;
  const W = 320, H = 140, pad = 28;
  const ts = points.map((p) => p.t), vs = points.map((p) => p.v);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  let v0 = Math.min(...vs), v1 = Math.max(...vs);
  if (v0 === v1) { v0 -= 1; v1 += 1; }
  const x = (t: number) => pad + ((t - t0) / (t1 - t0 || 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - ((v - v0) / (v1 - v0)) * (H - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="small"><strong>{label}の推移</strong>（{unit}）</figcaption>
      <svg className="hl-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}の推移の折れ線グラフ。${points.length}件`}>
        <line className="axis" x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} />
        <line className="axis" x1={pad} y1={pad} x2={pad} y2={H - pad} />
        <path className="line" d={d} />
        {points.map((p) => <circle key={p.t} className="dot" cx={x(p.t)} cy={y(p.v)} r={3} />)}
        <text x={pad} y={H - 8}>{toDateStr(new Date(t0)).slice(5)}</text>
        <text x={W - pad} y={H - 8} textAnchor="end">{toDateStr(new Date(t1)).slice(5)}</text>
        <text x={pad - 4} y={pad + 4} textAnchor="end">{v1}</text>
        <text x={pad - 4} y={H - pad} textAnchor="end">{v0}</text>
      </svg>
    </figure>
  );
}

export function GrowthPage() {
  const { familyId, childId } = useIds();
  const { data, loading } = useRecentEvents(['growth'], 100);
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => data.map((e) => ({ id: e.id, occurredAt: tsToDate(e.occurredAt), payload: e.payload as unknown as Record<string, unknown>, pending: e._pending })), [data]);
  const w = useMemo(() => growthSeries(rows, 'weightGrams').map((p) => ({ t: p.t, v: p.v / 1000 })), [rows]);
  const h = useMemo(() => growthSeries(rows, 'heightCm'), [rows]);
  return (
    <div className="page">
      <PageHeader title="身長・体重" />
      <Button variant="primary" onClick={() => setOpen(true)} disabled={!familyId || !childId}>身長・体重を記録</Button>
      <p className="small muted">数値の記録と推移の表示のみです。成長の評価や基準との比較はしません。気になることは健診や医療機関で相談してください。</p>
      {loading ? <p className="muted" role="status">読み込み中…</p> : rows.length === 0 ? <EmptyState title="まだ記録がありません" icon="growth" /> : (
        <>
          <Card><div className="stack"><Chart points={w} label="体重" unit="kg" /><Chart points={h} label="身長" unit="cm" /></div></Card>
          <Card>
            <table className="hl-table">
              <caption className="small muted" style={{ textAlign: 'left' }}>測定日ごとの記録</caption>
              <thead><tr><th>測定日</th><th>身長</th><th>体重</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDateJa(toDateStr(r.occurredAt))}{r.pending ? '（未同期）' : ''}<div className="muted">{dateTimeText(r.occurredAt).slice(-5)}</div></td>
                    <td>{typeof r.payload.heightCm === 'number' ? `${r.payload.heightCm} cm` : '—'}</td>
                    <td>{typeof r.payload.weightGrams === 'number' ? `${gramsToKgText(r.payload.weightGrams)} kg（${r.payload.weightGrams} g）` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
      {familyId && childId && <GrowthSheet open={open} onClose={() => setOpen(false)} />}
    </div>
  );
}

function GrowthSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { familyId, childId } = useIds();
  const toast = useToast();
  const [height, setHeight] = useState('');
  const [kg, setKg] = useState('');
  const [place, setPlace] = useState('');
  const [when, setWhen] = useState(newWhen());
  const [touched, setTouched] = useState(false);
  const hv = parseNum(height);
  const wg = kgToGrams(kg);
  const bad = (height.trim() !== '' && hv === null) || (kg.trim() !== '' && wg === null);
  const err = bad ? '数字で入力してください' : validateGrowth(hv, wg);
  const submit = () => {
    setTouched(true);
    if (err || !familyId || !childId) return;
    const payload: EventPayloadMap['growth'] = {};
    if (hv !== null) payload.heightCm = hv;
    if (wg !== null) payload.weightGrams = wg;
    if (place.trim()) payload.measurementPlace = place.trim();
    createEvent(familyId, childId, { type: 'growth', occurredAt: resolveWhen(when), payload });
    toast.show('身長・体重を記録しました');
    setHeight(''); setKg(''); setPlace(''); setTouched(false); setWhen(newWhen()); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="身長・体重を記録" footer={<Button variant="primary" block onClick={submit}>記録する</Button>}>
      <div className="stack">
        {touched && err && <div className="small ch-field__error" role="alert">{err}</div>}
        <Field label="身長（cm）" optional>{({ id }) => <TextInput id={id} inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="50.5" />}</Field>
        <Field label="体重（kg）" optional hint="kgで入力すると g に変換して保存します（例 3.456kg → 3456g）">
          {({ id }) => <TextInput id={id} inputMode="decimal" value={kg} onChange={(e) => setKg(e.target.value)} placeholder="3.456" />}
        </Field>
        <Field label="測定した場所" optional>{({ id }) => <TextInput id={id} maxLength={200} value={place} onChange={(e) => setPlace(e.target.value)} placeholder="自宅／健診／病院" />}</Field>
        <WhenField value={when} onChange={setWhen} label="測定日時" />
      </div>
    </Sheet>
  );
}
