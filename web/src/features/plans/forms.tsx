import { useState, type ReactNode } from 'react';
import { Button, Field, SegmentedControl, Select, TextArea, TextInput } from '../../components';
import { useAuth, useFamily } from '../../context';
import { combineDateTime, formatTime, toDateStr, todayStr } from '../../lib/time';
import type { RelatedRef } from '../../types/models';
import { isSafeHttpsUrl } from './logic/plans';
import type { PHandover, PSchedule, PTask } from './types';
import { AssigneeChips, OfflineNotice, RefPicker, SingleAssignee, SCHEDULE_CATEGORY, TASK_CATEGORY, TASK_STATUS, useOnline } from './ui';

function Footer({ busy, label, canSubmit }: { busy?: boolean; label: string; canSubmit: boolean }) {
  const online = useOnline();
  return (
    <div className="stack">
      {!online && <OfflineNotice />}
      <Button type="submit" variant="primary" block loading={busy} disabled={!online || !canSubmit}>{label}</Button>
    </div>
  );
}

const opts = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));

// ---------- 予定 ----------
export interface ScheduleValues {
  title: string; category: 'medical' | 'procedure' | 'other'; allDay: boolean;
  date: string; startAt: Date | null; endAt: Date | null;
  location: string | null; preparation: string | null; assigneeUids: string[];
}

export function ScheduleForm({ initial, submitLabel, busy, onSubmit, notice }: {
  initial?: PSchedule; submitLabel: string; busy?: boolean; onSubmit: (v: ScheduleValues) => void; notice?: ReactNode;
}) {
  const { user } = useAuth();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [category, setCategory] = useState<ScheduleValues['category']>(initial?.category ?? 'medical');
  const [allDay, setAllDay] = useState(initial?.allDay ?? false);
  const [date, setDate] = useState(
    initial ? (initial.allDay ? initial.date ?? todayStr() : initial.startAt ? toDateStr(initial.startAt.toDate()) : todayStr()) : todayStr(),
  );
  const [start, setStart] = useState(initial?.startAt ? formatTime(initial.startAt.toDate()) : '10:00');
  const [end, setEnd] = useState(initial?.endAt ? formatTime(initial.endAt.toDate()) : '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [prep, setPrep] = useState(initial?.preparation ?? '');
  const [assignees, setAssignees] = useState<string[]>(initial?.assigneeUids ?? (user ? [user.uid] : []));
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    if (!title.trim()) return setErr('タイトルを入力してください');
    if (!date) return setErr('日付を入力してください');
    let startAt: Date | null = null, endAt: Date | null = null;
    if (!allDay) {
      if (!start) return setErr('開始時刻を入力してください');
      startAt = combineDateTime(date, start);
      if (end) {
        endAt = combineDateTime(date, end);
        if (endAt.getTime() < startAt.getTime()) return setErr('終了時刻は開始より後にしてください');
      }
    }
    setErr(null);
    onSubmit({ title: title.trim(), category, allDay, date, startAt, endAt, location: location.trim() || null, preparation: prep.trim() || null, assigneeUids: assignees });
  };

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {notice}
      <Field label="タイトル" error={err && !title.trim() ? err : undefined}>
        {({ id }) => <TextInput id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="例：1か月健診" />}
      </Field>
      <Field label="カテゴリ">
        {() => <SegmentedControl ariaLabel="カテゴリ" value={category} onChange={setCategory} options={opts(SCHEDULE_CATEGORY) as { value: ScheduleValues['category']; label: string }[]} />}
      </Field>
      <Field label="日付">
        {({ id }) => <TextInput id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
      </Field>
      <label className="pl-checkrow">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> 終日
      </label>
      {!allDay && (
        <div className="ch-pair">
          <Field label="開始">{({ id }) => <TextInput id={id} type="time" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label="終了" optional>{({ id }) => <TextInput id={id} type="time" value={end} onChange={(e) => setEnd(e.target.value)} />}</Field>
        </div>
      )}
      <Field label="場所" optional>
        {({ id }) => <TextInput id={id} value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} />}
      </Field>
      <Field label="担当（複数可）" optional>{() => <AssigneeChips label="担当" value={assignees} onChange={setAssignees} />}</Field>
      <Field label="準備物" optional>
        {({ id }) => <TextArea id={id} rows={3} maxLength={2000} value={prep} onChange={(e) => setPrep(e.target.value)} placeholder="母子手帳、保険証 など" />}
      </Field>
      {err && title.trim() && <p className="ch-field__error small" role="alert">{err}</p>}
      <Footer busy={busy} label={submitLabel} canSubmit />
    </form>
  );
}

// ---------- ToDo ----------
export interface TaskValues {
  title: string; category: 'procedure' | 'household' | 'medical' | 'other'; status: 'todo' | 'doing' | 'done';
  assigneeUid: string | null; dueDate: string | null; deadlineBasis: string | null; deadlineVerified: boolean;
  sourceUrl: string | null; step: string | null;
}

export function TaskForm({ initial, submitLabel, busy, onSubmit, notice }: {
  initial?: PTask; submitLabel: string; busy?: boolean; onSubmit: (v: TaskValues) => void; notice?: ReactNode;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [category, setCategory] = useState<TaskValues['category']>(initial?.category ?? 'other');
  const [status, setStatus] = useState<TaskValues['status']>(initial?.status ?? 'todo');
  const [assignee, setAssignee] = useState<string | null>(initial?.assigneeUid ?? null);
  const [due, setDue] = useState(initial?.dueDate ?? '');
  const [basis, setBasis] = useState(initial?.deadlineBasis ?? '');
  const [verified, setVerified] = useState(initial?.deadlineVerified ?? false);
  const [url, setUrl] = useState(initial?.sourceUrl ?? '');
  const [step, setStep] = useState(initial?.step ?? '');
  const [err, setErr] = useState<{ title?: string; url?: string }>({});

  const submit = () => {
    const e: typeof err = {};
    if (!title.trim()) e.title = 'タイトルを入力してください';
    if (url.trim() && !isSafeHttpsUrl(url.trim())) e.url = 'https:// で始まるURLを入力してください';
    setErr(e);
    if (e.title || e.url) return;
    onSubmit({
      title: title.trim(), category, status, assigneeUid: assignee, dueDate: due || null,
      deadlineBasis: basis.trim() || null, deadlineVerified: due ? verified : false,
      sourceUrl: url.trim() || null, step: step.trim() || null,
    });
  };

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {notice}
      <Field label="やること" error={err.title}>
        {({ id }) => <TextInput id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="例：児童手当の申請先を確認" />}
      </Field>
      <Field label="カテゴリ">
        {({ id }) => <Select id={id} value={category} onChange={(v) => setCategory(v as TaskValues['category'])} options={opts(TASK_CATEGORY)} />}
      </Field>
      {initial && (
        <Field label="状態">
          {() => <SegmentedControl ariaLabel="状態" value={status} onChange={setStatus} options={opts(TASK_STATUS) as { value: TaskValues['status']; label: string }[]} />}
        </Field>
      )}
      <Field label="担当">{({ id }) => <SingleAssignee id={id} value={assignee} onChange={setAssignee} />}</Field>
      <Field label="期限" optional hint="日付のみ（家族のタイムゾーンの日付）">
        {({ id }) => <TextInput id={id} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}
      </Field>
      {due && (
        <>
          <Field label="期限の根拠" optional hint="自治体・勤務先の案内など。確認していない日付は目安として扱われます">
            {({ id }) => <TextArea id={id} rows={2} maxLength={200} value={basis} onChange={(e) => setBasis(e.target.value)} />}
          </Field>
          <label className="pl-checkrow">
            <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} /> 公式の案内で期限を確認済み
          </label>
        </>
      )}
      <Field label="公式URL" optional error={err.url}>
        {({ id }) => <TextInput id={id} type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />}
      </Field>
      <Field label="手続きの段階" optional hint="例：必要書類の確認 → 提出 → 受理確認">
        {({ id }) => <TextInput id={id} value={step} maxLength={2000} onChange={(e) => setStep(e.target.value)} />}
      </Field>
      <Footer busy={busy} label={submitLabel} canSubmit />
    </form>
  );
}

// ---------- 買い物 ----------
export interface ShoppingValues { name: string; brand: string | null; size: string | null; quantity: number | null; assigneeUid: string | null }

export function ShoppingForm({ submitLabel, busy, onSubmit }: { submitLabel: string; busy?: boolean; onSubmit: (v: ShoppingValues) => void }) {
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [size, setSize] = useState('');
  const [qty, setQty] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    if (!name.trim()) return setErr('品名を入力してください');
    const q = qty.trim() === '' ? null : Number(qty);
    if (q !== null && (!Number.isInteger(q) || q < 0 || q > 10000)) return setErr('数量は0以上の整数で入力してください');
    setErr(null);
    onSubmit({ name: name.trim(), brand: brand.trim() || null, size: size.trim() || null, quantity: q, assigneeUid: assignee });
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Field label="品名" error={err ?? undefined}>
        {({ id }) => <TextInput id={id} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="例：おしりふき" />}
      </Field>
      <Field label="銘柄" optional>{({ id }) => <TextInput id={id} value={brand} maxLength={200} onChange={(e) => setBrand(e.target.value)} />}</Field>
      <Field label="サイズ" optional>{({ id }) => <TextInput id={id} value={size} maxLength={200} onChange={(e) => setSize(e.target.value)} placeholder="例：新生児用 / S" />}</Field>
      <Field label="数量" optional>{({ id }) => <TextInput id={id} type="number" inputMode="numeric" min={0} value={qty} onChange={(e) => setQty(e.target.value)} />}</Field>
      <Field label="購入担当" optional>{({ id }) => <SingleAssignee id={id} value={assignee} onChange={setAssignee} />}</Field>
      <Footer busy={busy} label={submitLabel} canSubmit />
    </form>
  );
}

// ---------- 申し送り ----------
export interface HandoverValues {
  text: string; priority: 'normal' | 'important'; recipientUids: string[]; expiresDate: string | null; relatedRefs: RelatedRef[];
}

export function HandoverForm({ initial, submitLabel, busy, onSubmit, notice }: {
  initial?: PHandover; submitLabel: string; busy?: boolean; onSubmit: (v: HandoverValues) => void; notice?: ReactNode;
}) {
  const { user } = useAuth();
  const { activeMembers } = useFamily();
  const others = activeMembers.filter((m) => m.uid !== user?.uid).map((m) => m.uid);
  const [text, setText] = useState(initial?.text ?? '');
  const [priority, setPriority] = useState<'normal' | 'important'>(initial?.priority ?? 'normal');
  const [to, setTo] = useState<'all' | 'other'>(initial && initial.recipientUids.length > 0 ? 'other' : 'all');
  const [exp, setExp] = useState(initial?.expiresAt ? toDateStr(initial.expiresAt.toDate()) : '');
  const [refs, setRefs] = useState<RelatedRef[]>(initial?.relatedRefs ?? []);
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    if (!text.trim()) return setErr('内容を入力してください');
    setErr(null);
    // 「相手」: 編集時は元の宛先を保持し、新規は自分以外の全員
    const recipientUids = to === 'all' ? [] : initial && initial.recipientUids.length > 0 ? initial.recipientUids : others;
    onSubmit({ text: text.trim(), priority, recipientUids, expiresDate: exp || null, relatedRefs: refs });
  };

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {notice}
      <Field label="内容" error={err ?? undefined}>
        {({ id }) => <TextArea id={id} rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="例：受診で昨夜の様子を相談したい" />}
      </Field>
      <Field label="重要度">
        {() => <SegmentedControl ariaLabel="重要度" value={priority} onChange={setPriority} options={[{ value: 'normal', label: '通常' }, { value: 'important', label: '重要' }]} />}
      </Field>
      <Field label="宛先">
        {() => <SegmentedControl ariaLabel="宛先" value={to} onChange={setTo} options={[{ value: 'all', label: '全員' }, { value: 'other', label: '相手' }]} />}
      </Field>
      <Field label="期限" optional hint="この日を過ぎるとホームには出ません">
        {({ id }) => <TextInput id={id} type="date" value={exp} onChange={(e) => setExp(e.target.value)} />}
      </Field>
      <Field label="関連先" optional>{() => <RefPicker value={refs} onChange={setRefs} />}</Field>
      <p className="small muted">確認は「受け取った」ことを示すだけで、対応の完了ではありません。内容を変えると再確認が必要になります。</p>
      <Footer busy={busy} label={submitLabel} canSubmit />
    </form>
  );
}

