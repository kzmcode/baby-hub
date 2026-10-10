import { useEffect, useMemo, useState } from 'react';
import { Button, ConflictNotice, Field, MemberPicker, SegmentedControl, Sheet, TextArea, TextInput, TimeInput, useToast } from '../../components';
import { useAuth, useFamily } from '../../context';
import { api, apiErrorMessage, ApiError, toApiError } from '../../lib/api';
import { useDocument, paths } from '../../lib/db';
import { dayRange, todayStr } from '../../lib/time';
import type { DailyEvent, FeedingMethod, YesNoUnknown } from '../../types/models';
import { describeEvent } from './logic/describe';
import { currentSleepState } from './logic/sleep';
import { toEv, type Ev, type EventDoc } from './logic/types';
import { useEventsRange } from './hooks';
import { useRecorder } from './recorder';

export type RecordSheetType = 'diaper' | 'feeding' | 'vomit' | 'sleep' | 'bath' | 'other';

export interface RecordSheetProps {
  open: boolean;
  type: RecordSheetType;
  onClose: () => void;
  /** 指定すると訂正モード（updateEvent、expectedRevision 付き） */
  initialEvent?: Ev | null;
  onSaved?: (eventId: string) => void;
}

const TITLES: Record<RecordSheetType, string> = {
  diaper: 'おむつ', feeding: '授乳・ミルク', vomit: '吐いた', sleep: '寝た／起きた', bath: '沐浴', other: 'その他の変化',
};
export const OTHER_TAGS = ['機嫌がよい', 'ぐずり', 'よく泣く', 'よく笑った', 'しゃっくり', '湿疹', '肌が赤い', 'うんちの色が気になる', 'いつもと違う', 'できたこと'];
const PRESETS = [40, 60, 80, 100, 120, 160];
type FeedChoice = 'breast' | 'formula' | 'expressed_breast_milk' | 'pumping';
type DiaperChoice = 'urine' | 'stool' | 'both' | 'unknown';

/** イベント → シート種別 */
export function sheetTypeOf(e: Ev): RecordSheetType | null {
  switch (e.type) {
    case 'feeding': case 'pumping': return 'feeding';
    case 'diaper': return 'diaper';
    case 'vomit': return 'vomit';
    case 'bath': return 'bath';
    case 'memo': return 'other';
    case 'sleep_start': case 'sleep_end': return 'sleep';
    default: return null;
  }
}

const diaperFrom = (c: DiaperChoice): { urine: YesNoUnknown; stool: YesNoUnknown } =>
  c === 'urine' ? { urine: 'yes', stool: 'no' } : c === 'stool' ? { urine: 'no', stool: 'yes' } : c === 'both' ? { urine: 'yes', stool: 'yes' } : { urine: 'unknown', stool: 'unknown' };
const choiceFromDiaper = (p: Record<string, unknown>): DiaperChoice | null =>
  p.urine === 'yes' && p.stool === 'yes' ? 'both' : p.urine === 'yes' && p.stool === 'no' ? 'urine' : p.urine === 'no' && p.stool === 'yes' ? 'stool'
  : p.urine === 'unknown' && p.stool === 'unknown' ? 'unknown' : null;

const minToSec = (v: string): number | undefined => {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.round(n * 60) : undefined;
};
const mlOf = (v: string): number | undefined => {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 500 ? n : undefined;
};

export function RecordSheet({ open, type, onClose, initialEvent, onSaved }: RecordSheetProps) {
  const { user } = useAuth();
  const { familyId, childId, child } = useFamily();
  const toast = useToast();
  const { record } = useRecorder();
  const editing = !!initialEvent;
  const myUid = user?.uid ?? null;

  const [when, setWhen] = useState(() => new Date());
  const [caregiver, setCaregiver] = useState<string | null>(myUid);
  const [note, setNote] = useState('');
  const [feed, setFeed] = useState<FeedChoice>('formula');
  const [ml, setMl] = useState('');
  const [leftMin, setLeftMin] = useState('');
  const [rightMin, setRightMin] = useState('');
  const [diaper, setDiaper] = useState<DiaperChoice | null>(null);
  const [stoolNote, setStoolNote] = useState('');
  const [amountCat, setAmountCat] = useState<'' | 'small' | 'medium' | 'large' | 'unknown'>('');
  const [appearance, setAppearance] = useState('');
  const [bathMode, setBathMode] = useState<'' | 'sponge' | 'tub'>('');
  const [tags, setTags] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [sleepKind, setSleepKind] = useState<'start' | 'end'>('start');
  const [confirmDouble, setConfirmDouble] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictRev, setConflictRev] = useState<number | null>(null);

  // 睡眠状態（睡眠シートのときだけ購読）
  const sleepWin = useMemo(() => {
    if (!open || type !== 'sleep') return { s: null, e: null };
    const t = dayRange(todayStr());
    return { s: new Date(t.start.getTime() - 2 * 86400000), e: t.end };
  }, [open, type]);
  const { sessions } = useEventsRange(sleepWin.s, sleepWin.e, 0, 0);
  const sleepNow = useMemo(() => currentSleepState(sessions), [sessions]);

  // 訂正時の最新版（競合の確認用）
  const live = useDocument<DailyEvent>(open && editing && familyId && childId ? paths.event(familyId, childId, initialEvent!.id) : null);
  const latest = live.data && initialEvent && live.data.revision !== initialEvent.revision ? toEv(live.data as EventDoc) : null;

  // 開くたびに初期化
  useEffect(() => {
    if (!open) return;
    const e = initialEvent;
    setError(null); setConflictRev(null); setConfirmDouble(false); setSaving(false);
    setWhen(e ? e.occurredAt : new Date());
    setCaregiver(e ? (e.caregiverUid ?? null) : myUid); // 前回の代理入力者は持ち越さない
    setNote(e?.note ?? '');
    const p = (e?.payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    setFeed(e?.type === 'pumping' ? 'pumping' : ((p.method as FeedChoice) ?? 'formula'));
    setMl(String(e?.type === 'pumping' ? p.expressedMl ?? '' : p.consumedMl ?? ''));
    setLeftMin(p.leftSeconds ? String(Math.round(p.leftSeconds / 60)) : '');
    setRightMin(p.rightSeconds ? String(Math.round(p.rightSeconds / 60)) : '');
    setDiaper(e?.type === 'diaper' ? choiceFromDiaper(p) : null);
    setStoolNote(p.stoolNote ?? '');
    setAmountCat(p.amountCategory ?? '');
    setAppearance(p.appearanceText ?? '');
    setBathMode(p.bathingMode ?? '');
    setTags(e?.type === 'memo' ? p.tags ?? [] : []);
    setText(e?.type === 'memo' ? p.text ?? '' : '');
    setSleepKind(e?.type === 'sleep_end' ? 'end' : 'start');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialEvent?.id, type]);

  // 睡眠: 新規時は状態に合わせて既定を寝た/起きたにする
  useEffect(() => {
    if (open && type === 'sleep' && !editing) setSleepKind(sleepNow.kind === 'sleeping' ? 'end' : 'start');
  }, [open, type, editing, sleepNow.kind]);

  const title = `${child?.nickname ?? ''}｜${TITLES[type]}${editing ? 'を訂正' : ''}`;

  /** 種別ごとの payload を作る（量などの未入力は省略）。edit=true のときは未入力を null（キー削除）にする */
  function buildPayload(forEdit: boolean, diaperOverride?: DiaperChoice): Record<string, unknown> | null {
    const del = forEdit ? null : undefined;
    switch (type) {
      case 'diaper': {
        const c = diaperOverride ?? diaper;
        if (!c) return null;
        return { ...diaperFrom(c), changed: true, stoolNote: stoolNote.trim() || del };
      }
      case 'feeding':
        if (feed === 'pumping') return { expressedMl: mlOf(ml) ?? del };
        return {
          method: feed as FeedingMethod,
          consumedMl: mlOf(ml) ?? del,
          ...(feed === 'breast' ? { leftSeconds: minToSec(leftMin) ?? del, rightSeconds: minToSec(rightMin) ?? del } : {}),
        };
      case 'vomit': return { amountCategory: amountCat || del, appearanceText: appearance.trim() || del };
      case 'bath': return { bathingMode: bathMode || del };
      case 'other': return { tags: tags.length ? tags : del, text: text.trim() || del };
      default: return {};
    }
  }

  function clean(o: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  }

  function validate(): string | null {
    if (when.getTime() > Date.now() + 5 * 60000) return '未来の時刻は記録できません。';
    if (type === 'feeding' && ml.trim() !== '' && mlOf(ml) === undefined) return '量は 0〜500 の数値で入力してください（分からないときは空欄のまま）。';
    if (type === 'other' && !editing && tags.length === 0 && text.trim() === '') return 'タグを選ぶか、短文を入力してください。';
    if (type === 'diaper' && !diaper) return '尿・便の状態を選んでください。';
    return null;
  }

  async function save(diaperOverride?: DiaperChoice) {
    if (!familyId || !childId) return;
    setError(null);
    if (diaperOverride) setDiaper(diaperOverride);
    const v = type === 'diaper' && diaperOverride ? null : validate();
    if (v) { setError(v); return; }

    // 睡眠の特別処理
    if (type === 'sleep') return saveSleep();

    if (editing && initialEvent) {
      const payloadRaw = buildPayload(true, diaperOverride)!;
      setSaving(true);
      try {
        await api.updateEvent({
          familyId, childId, eventId: initialEvent.id,
          expectedRevision: conflictRev ?? initialEvent.revision,
          patch: {
            occurredAt: when.toISOString(),
            caregiverUid: caregiver,
            payload: payloadRaw,
            note: note.trim() || null,
          },
        });
        toast.show('訂正しました');
        onSaved?.(initialEvent.id);
        onClose();
      } catch (e) {
        handleError(e);
      } finally { setSaving(false); }
      return;
    }

    const payload = clean(buildPayload(false, diaperOverride)!);
    const label = type === 'feeding' ? (feed === 'pumping' ? '搾乳' : { breast: '母乳', formula: 'ミルク', expressed_breast_milk: '搾母乳' }[feed as 'breast']) : TITLES[type];
    const evType = type === 'feeding' ? (feed === 'pumping' ? 'pumping' : 'feeding') : type === 'other' ? 'memo' : type;
    const id = record(
      { type: evType, occurredAt: when, caregiverUid: caregiver, payload: payload as never, note: note.trim() || undefined },
      label as string,
    );
    if (id) { onSaved?.(id); onClose(); }
  }

  async function saveSleep() {
    if (!familyId || !childId) return;
    if (editing && initialEvent) {
      setSaving(true);
      try {
        await api.updateEvent({
          familyId, childId, eventId: initialEvent.id,
          expectedRevision: conflictRev ?? initialEvent.revision,
          patch: { occurredAt: when.toISOString(), caregiverUid: caregiver, note: note.trim() || null },
        });
        toast.show('訂正しました');
        onSaved?.(initialEvent.id);
        onClose();
      } catch (e) { handleError(e); } finally { setSaving(false); }
      return;
    }
    if (sleepKind === 'start') {
      if (sleepNow.kind !== 'awake' && !confirmDouble) { setConfirmDouble(true); return; }
      const sessionId = crypto.randomUUID();
      const id = record({ type: 'sleep_start', occurredAt: when, caregiverUid: caregiver, sessionId, payload: { sessionId }, note: note.trim() || undefined }, '寝た');
      if (id) { onSaved?.(id); onClose(); }
    } else {
      if (sleepNow.kind !== 'sleeping') { setError('終了していない睡眠が1件に特定できません。記録画面で睡眠の状態を確認してください。'); return; }
      const s = sleepNow.session;
      if (s.start && when < s.start) { setError('起きた時刻が寝た時刻より前になっています。'); return; }
      const id = record(
        { type: 'sleep_end', occurredAt: when, caregiverUid: caregiver, sessionId: s.sessionId, payload: { sessionId: s.sessionId, startEventId: s.startEventId! }, note: note.trim() || undefined },
        '起きた',
      );
      if (id) { onSaved?.(id); onClose(); }
    }
  }

  function handleError(e: unknown) {
    const a: ApiError = toApiError(e);
    if (a.isConflict) {
      setConflictRev(a.conflict?.currentRevision ?? null);
      setError(null);
    } else setError(apiErrorMessage(e));
  }

  const body = (
    <div className="stack">
      {conflictRev != null && (
        <ConflictNotice
          message="あなたの入力は残してあります。下に表示される最新の内容を確認し、問題なければ「この内容で保存し直す」を押してください。"
          onRetry={() => void save()}
        />
      )}
      {latest && (
        <div className="rec-latest small">
          最新の内容（r{latest.revision}）：{latest.occurredAt.getHours().toString().padStart(2, '0')}:{latest.occurredAt.getMinutes().toString().padStart(2, '0')}{' '}
          {describeEvent(latest).title} {describeEvent(latest).detail ?? ''}
        </div>
      )}

      {type === 'diaper' && (
        <div>
          <div className="ch-field__label">{editing ? '尿・便' : 'タップで保存'}</div>
          <div className="rec-choices">
            {([['urine', '尿'], ['stool', '便'], ['both', '両方（尿＋便）'], ['unknown', '交換のみ・未確認']] as [DiaperChoice, string][]).map(([k, l]) => (
              <button
                key={k}
                type="button"
                className={`rec-choice${diaper === k ? ' is-active' : ''}`}
                disabled={saving}
                onClick={() => (editing ? setDiaper(k) : void save(k))}
              >{l}</button>
            ))}
          </div>
          {editing && (
            <Field label="便の様子" optional>
              {({ id }) => <TextInput id={id} value={stoolNote} maxLength={200} onChange={(e) => setStoolNote(e.target.value)} />}
            </Field>
          )}
        </div>
      )}

      {type === 'feeding' && (
        <>
          <SegmentedControl<FeedChoice>
            ariaLabel="種類"
            value={feed}
            onChange={setFeed}
            options={[
              { value: 'breast' as FeedChoice, label: '母乳' }, { value: 'formula' as FeedChoice, label: 'ミルク' },
              { value: 'expressed_breast_milk' as FeedChoice, label: '搾母乳' }, { value: 'pumping' as FeedChoice, label: '搾乳' },
            ].filter((o) => !editing || (initialEvent?.type === 'pumping' ? o.value === 'pumping' : o.value !== 'pumping'))}
          />
          <div>
            <div className="ch-field__label">{feed === 'pumping' ? '搾った量' : '飲んだ量'}<span className="muted small">（任意・未入力は「量未入力」）</span></div>
            <div className="rec-choices rec-choices--presets">
              {PRESETS.map((p) => (
                <button key={p} type="button" className={`rec-choice${ml === String(p) ? ' is-active' : ''}`} onClick={() => setMl(ml === String(p) ? '' : String(p))}>{p}mL</button>
              ))}
            </div>
            <Field label="手入力（mL）" optional>
              {({ id }) => <TextInput id={id} inputMode="numeric" value={ml} onChange={(e) => setMl(e.target.value.replace(/[^\d.]/g, ''))} placeholder="例: 90" />}
            </Field>
            {feed === 'pumping' && <p className="small muted">搾乳量は哺乳量には加算されません。</p>}
          </div>
          {feed === 'breast' && (
            <div className="row">
              <Field label="左（分）" optional>{({ id }) => <TextInput id={id} inputMode="numeric" value={leftMin} onChange={(e) => setLeftMin(e.target.value.replace(/\D/g, ''))} />}</Field>
              <Field label="右（分）" optional>{({ id }) => <TextInput id={id} inputMode="numeric" value={rightMin} onChange={(e) => setRightMin(e.target.value.replace(/\D/g, ''))} />}</Field>
            </div>
          )}
        </>
      )}

      {type === 'vomit' && (
        <>
          <div>
            <div className="ch-field__label">量の印象<span className="muted small">（任意）</span></div>
            <SegmentedControl<'' | 'small' | 'medium' | 'large' | 'unknown'>
              ariaLabel="量の印象" value={amountCat} onChange={setAmountCat}
              options={[{ value: '', label: '未選択' }, { value: 'small', label: '少量' }, { value: 'medium', label: '中くらい' }, { value: 'large', label: '多め' }, { value: 'unknown', label: '不明' }]}
            />
          </div>
          <Field label="様子の短文" optional>{({ id }) => <TextInput id={id} value={appearance} maxLength={200} onChange={(e) => setAppearance(e.target.value)} />}</Field>
        </>
      )}

      {type === 'bath' && (
        <SegmentedControl<'' | 'sponge' | 'tub'>
          ariaLabel="沐浴の種類" value={bathMode} onChange={setBathMode}
          options={[{ value: '', label: '指定しない' }, { value: 'tub', label: '浴槽' }, { value: 'sponge', label: 'スポンジ' }]}
        />
      )}

      {type === 'other' && (
        <>
          <div>
            <div className="ch-field__label">タグ</div>
            <div className="rec-choices rec-choices--tags">
              {OTHER_TAGS.map((t) => (
                <button key={t} type="button" aria-pressed={tags.includes(t)} className={`rec-choice${tags.includes(t) ? ' is-active' : ''}`}
                  onClick={() => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])}>{t}</button>
              ))}
            </div>
          </div>
          <Field label="短文" optional>{({ id }) => <TextInput id={id} value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />}</Field>
          <p className="small muted">観察の記録です。診断や評価ではありません。</p>
        </>
      )}

      {type === 'sleep' && (
        <>
          {editing ? (
            <p>{initialEvent?.type === 'sleep_end' ? '起きた' : '寝た'}の時刻・実施者を訂正できます。</p>
          ) : (
            <SegmentedControl<'start' | 'end'>
              ariaLabel="寝た／起きた" value={sleepKind} onChange={(v) => { setSleepKind(v); setConfirmDouble(false); }}
              options={[{ value: 'start', label: '寝た' }, { value: 'end', label: '起きた' }]}
            />
          )}
          {!editing && sleepNow.kind === 'sleeping' && sleepKind === 'start' && (
            <p className="rec-warn">すでに睡眠中（記録上）です。もう一度「寝た」を記録すると、睡眠が重複して「確認待ち」になります。</p>
          )}
          {!editing && sleepNow.kind === 'unconfirmed' && (
            <p className="rec-warn">睡眠の記録に矛盾があり「確認待ち」です。記録画面で該当の記録を訂正・無効化してください。</p>
          )}
          {confirmDouble && (
            <div className="rec-warn" role="alert">
              <strong>本当に「寝た」を追加しますか？</strong>
              <p className="small">現在、睡眠が終了していません。追加すると両方が確認待ちになり、後から訂正・無効化が必要になります。</p>
              <div className="row">
                <Button variant="danger" onClick={() => void saveSleep()}>重複を承知で追加する</Button>
                <Button onClick={() => setConfirmDouble(false)}>やめる</Button>
              </div>
            </div>
          )}
        </>
      )}

      <TimeInput value={when} onChange={setWhen} label="実施時刻" withDate />
      <div>
        <div className="ch-field__label">実施者</div>
        <MemberPicker value={caregiver} onChange={setCaregiver} label="実施者" />
      </div>
      {(editing || type === 'vomit' || type === 'other') && (
        <Field label="メモ" optional>{({ id }) => <TextArea id={id} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />}</Field>
      )}
      {error && <p className="ch-field__error" role="alert">{error}</p>}
      {!editing && <p className="small muted">保存は端末に即反映され、通信できるときに共有されます。</p>}
    </div>
  );

  const hideSave = type === 'diaper' && !editing;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        hideSave ? undefined : (
          <>
            <Button variant="ghost" onClick={onClose}>キャンセル</Button>
            <Button variant="primary" block loading={saving} onClick={() => void save()}>{editing ? '訂正を保存' : '保存'}</Button>
          </>
        )
      }
    >
      {body}
    </Sheet>
  );
}
