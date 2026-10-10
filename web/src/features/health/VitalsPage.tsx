// 体温・症状（保護者の観察）
import { useState } from 'react';
import { useFamily } from '../../context';
import { createEvent } from '../../lib/db';
import { Button, Card, EmptyState, Field, MemberPicker, Select, Sheet, SyncBadge, syncStateOf, TextArea, TextInput, useToast } from '../../components';
import { useIds, useRecentEvents, PageHeader, WhenField, newWhen, resolveWhen, tsToDate, dateTimeText } from './shared';
import { parseNum, validateCelsius } from './logic/units';
import type { EventPayloadMap } from '../../types/models';

const METHODS: { value: string; label: string }[] = [
  { value: '', label: '未選択' }, { value: 'axillary', label: 'わき' }, { value: 'ear', label: '耳' },
  { value: 'forehead', label: 'おでこ' }, { value: 'rectal', label: 'おしり' }, { value: 'other', label: 'その他' },
];
const METHOD_LABEL = Object.fromEntries(METHODS.map((m) => [m.value, m.label]));
export const SYMPTOM_TAGS = ['咳', '鼻水', '機嫌が悪い', '食欲が落ちた', '発疹', '下痢', 'ぐったりして見える', 'よく泣く', 'その他'];

export function VitalsPage() {
  const { familyId, childId } = useIds();
  const { memberName } = useFamily();
  const { data, loading } = useRecentEvents(['temperature', 'symptom'], 50);
  const [sheet, setSheet] = useState<'temp' | 'symptom' | null>(null);
  return (
    <div className="page">
      <PageHeader title="体温・症状" />
      <Card tone="warning">
        <p className="small">このアプリは診断や判断をしません。体調に不安があるときは医療機関や、小児救急電話相談(#8000。受付時間・対象地域は公式情報で確認)に相談してください。</p>
      </Card>
      <div className="hl-grid2">
        <Button variant="primary" onClick={() => setSheet('temp')} disabled={!familyId || !childId}>体温を記録</Button>
        <Button variant="primary" onClick={() => setSheet('symptom')} disabled={!familyId || !childId}>症状を記録</Button>
      </div>
      {loading ? <p className="muted" role="status">読み込み中…</p> : data.length === 0 ? (
        <EmptyState title="まだ記録がありません" icon="temperature" />
      ) : (
        <ul className="hl-list">
          {data.map((e) => {
            const p = e.payload as unknown as Record<string, unknown>;
            return (
              <li key={e.id}>
                <Card>
                  <div className="row">
                    <strong>{dateTimeText(tsToDate(e.occurredAt))}</strong>
                    <SyncBadge state={syncStateOf({ pending: e._pending })} />
                  </div>
                  {e.type === 'temperature' ? (
                    <p>体温 {String(p.celsius)}℃{p.measurementMethod ? `（${METHOD_LABEL[String(p.measurementMethod)] ?? ''}）` : ''}</p>
                  ) : (
                    <>
                      <p>症状（保護者の観察）: {((p.symptomTags as string[]) ?? []).join('、')}</p>
                      {typeof p.observedText === 'string' && p.observedText && <p className="small">{p.observedText}</p>}
                    </>
                  )}
                  {e.note && <p className="small muted">{e.note}</p>}
                  <p className="small muted">{e.caregiverUid && e.caregiverUid !== e.createdBy ? `${memberName(e.caregiverUid)} が測定・観察（${memberName(e.createdBy)} が入力）` : memberName(e.caregiverUid)}</p>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {familyId && childId && <TempSheet open={sheet === 'temp'} onClose={() => setSheet(null)} />}
      {familyId && childId && <SymptomSheet open={sheet === 'symptom'} onClose={() => setSheet(null)} />}
    </div>
  );
}

function TempSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { familyId, childId } = useIds();
  const toast = useToast();
  const [val, setVal] = useState('');
  const [method, setMethod] = useState('');
  const [when, setWhen] = useState(newWhen());
  const [who, setWho] = useState<string | null | undefined>(undefined);
  const [touched, setTouched] = useState(false);
  const n = parseNum(val);
  const err = validateCelsius(n);
  const submit = () => {
    setTouched(true);
    if (err || n === null || !familyId || !childId) return;
    const payload: EventPayloadMap['temperature'] = { celsius: n };
    if (method) payload.measurementMethod = method as EventPayloadMap['temperature']['measurementMethod'];
    createEvent(familyId, childId, { type: 'temperature', occurredAt: resolveWhen(when), caregiverUid: who, payload });
    toast.show('体温を記録しました');
    setVal(''); setTouched(false); setWhen(newWhen()); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="体温を記録" footer={<Button variant="primary" block onClick={submit}>記録する</Button>}>
      <div className="stack">
        <Field label="体温（℃）" error={touched && err ? err : undefined} hint="30〜45℃の範囲。測定値をそのまま入力してください">
          {({ id, describedBy, invalid }) => <TextInput id={id} aria-describedby={describedBy} aria-invalid={invalid} inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} placeholder="36.8" />}
        </Field>
        <Field label="測定方法" optional>{({ id }) => <Select id={id} value={method} options={METHODS} onChange={setMethod} />}</Field>
        <WhenField value={when} onChange={setWhen} label="測定時刻" />
        <MemberPicker label="測定した人" value={who === undefined ? null : who} onChange={setWho} />
      </div>
    </Sheet>
  );
}

function SymptomSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { familyId, childId } = useIds();
  const toast = useToast();
  const [tags, setTags] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [when, setWhen] = useState(newWhen());
  const [touched, setTouched] = useState(false);
  const submit = () => {
    setTouched(true);
    if (tags.length === 0 || !familyId || !childId) return;
    const payload: EventPayloadMap['symptom'] = { symptomTags: tags };
    if (text.trim()) payload.observedText = text.trim();
    createEvent(familyId, childId, { type: 'symptom', occurredAt: resolveWhen(when), payload });
    toast.show('症状を記録しました');
    setTags([]); setText(''); setTouched(false); setWhen(newWhen()); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="症状を記録（保護者の観察）" footer={<Button variant="primary" block onClick={submit}>記録する</Button>}>
      <div className="stack">
        <fieldset>
          <legend className="ch-field__label">気づいたこと（複数選択可）</legend>
          <div className="row">
            {SYMPTOM_TAGS.map((t) => {
              const on = tags.includes(t);
              return (
                <button key={t} type="button" aria-pressed={on} className={`ch-btn ${on ? 'ch-btn--primary' : ''}`} onClick={() => setTags(on ? tags.filter((x) => x !== t) : [...tags, t])}>{on ? '✓ ' : ''}{t}</button>
              );
            })}
          </div>
          {touched && tags.length === 0 && <div className="small ch-field__error" role="alert">1つ以上選んでください</div>}
        </fieldset>
        <Field label="様子（保護者の観察）" optional hint="見たこと・気づいたことをそのまま書いてください。原因や病名は書かなくて大丈夫です">
          {({ id }) => <TextArea id={id} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
        <WhenField value={when} onChange={setWhen} label="気づいた時刻" />
      </div>
    </Sheet>
  );
}
