import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { doc, limit, orderBy, query } from 'firebase/firestore';
import { Button, Card, Select, Sheet } from '../../components';
import { useFamily } from '../../context';
import { paths, useCollection, useDocument } from '../../lib/db';
import { useSyncStatus } from '../../lib/sync';
import { formatDateJa, formatTime, toDateStr } from '../../lib/time';
import type { DailyEvent, RelatedRef, Schedule, Task } from '../../types/models';

export const EVENT_LABEL: Record<string, string> = {
  feeding: '授乳・ミルク', pumping: '搾乳', diaper: 'おむつ', sleep_start: '寝た', sleep_end: '起きた', bath: '沐浴',
  vomit: '吐いた', temperature: '体温', symptom: '症状', growth: '成長', medication_taken: '服薬', meal: '食事',
  milestone: 'できたこと', memo: 'その他',
};
export const SCHEDULE_CATEGORY: Record<string, string> = { medical: '医療', procedure: '手続き', other: 'その他' };
export const TASK_CATEGORY: Record<string, string> = { procedure: '手続き', household: '家事', medical: '医療', other: 'その他' };
export const TASK_STATUS: Record<string, string> = { todo: '未着手', doing: '進行中', done: '完了' };
const REF_KIND: Record<string, string> = {
  event: '記録', schedule: '予定', task: 'ToDo', shopping: '買い物', handover: '申し送り',
  medicalVisit: '受診', vaccination: '接種・健診', medication: '薬',
};

export function useOnline(): boolean {
  return useSyncStatus().online;
}

export function OfflineNotice() {
  return (
    <p className="small muted" role="status">
      オフラインです。この操作はオンラインで保存されます。接続後にもう一度お試しください。
    </p>
  );
}

/** 複数担当の選択（有効メンバー） */
export function AssigneeChips({ value, onChange, label }: { value: string[]; onChange: (v: string[]) => void; label: string }) {
  const { activeMembers } = useFamily();
  const toggle = (uid: string) => onChange(value.includes(uid) ? value.filter((u) => u !== uid) : [...value, uid]);
  return (
    <div className="ch-seg" role="group" aria-label={label}>
      {activeMembers.map((m) => (
        <button key={m.uid} type="button" aria-pressed={value.includes(m.uid)} className={`ch-seg__item${value.includes(m.uid) ? ' is-active' : ''}`} onClick={() => toggle(m.uid)}>
          {m.displayName}
        </button>
      ))}
    </div>
  );
}

/** 単一担当（未担当を含む） */
export function SingleAssignee({ value, onChange, id }: { value: string | null; onChange: (v: string | null) => void; id?: string }) {
  const { activeMembers } = useFamily();
  return (
    <Select
      id={id}
      value={value ?? ''}
      onChange={(v) => onChange(v || null)}
      options={[{ value: '', label: '未担当' }, ...activeMembers.map((m) => ({ value: m.uid, label: m.displayName }))]}
    />
  );
}

/** 確認ダイアログ */
export function ConfirmSheet({
  open, title, message, confirmLabel, busy, onConfirm, onClose,
}: { open: boolean; title: string; message: ReactNode; confirmLabel: string; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="pl-actions">
          <Button onClick={onClose}>やめる</Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      }
    >
      <p>{message}</p>
    </Sheet>
  );
}

export function refPath(r: RelatedRef): string {
  switch (r.kind) {
    case 'event': return `/records/${r.id}`;
    case 'schedule': return `/plans/schedules/${r.id}`;
    case 'task': return `/plans/tasks/${r.id}`;
    case 'handover': return `/plans/handovers/${r.id}`;
    case 'shopping': return '/plans?tab=shopping';
    default: return '/health';
  }
}

/** 関連先リンク（タイトルを購読して表示） */
export function RefLink({ r }: { r: RelatedRef }) {
  const { familyId } = useFamily();
  const ref = !familyId
    ? null
    : r.kind === 'event' && r.childId ? paths.event(familyId, r.childId, r.id)
    : r.kind === 'schedule' ? doc(paths.schedules(familyId), r.id)
    : r.kind === 'task' ? doc(paths.tasks(familyId), r.id)
    : r.kind === 'handover' ? paths.handover(familyId, r.id)
    : null;
  const { data } = useDocument<Record<string, unknown>>(ref);
  let label = '';
  if (data) {
    if (r.kind === 'event') {
      const e = data as unknown as DailyEvent;
      label = `${EVENT_LABEL[e.type] ?? '記録'} ${e.occurredAt ? formatTime(e.occurredAt.toDate()) : ''}`;
    } else if (r.kind === 'handover') label = String(data.text ?? '').slice(0, 20);
    else label = String(data.title ?? '');
  }
  return (
    <Link to={refPath(r)} className="pl-badge">
      {REF_KIND[r.kind] ?? r.kind}{label ? `：${label}` : ''}
    </Link>
  );
}

export function RefList({ refs }: { refs: RelatedRef[] }) {
  if (!refs?.length) return null;
  return (
    <div className="row" aria-label="関連先">
      {refs.map((r) => <RefLink key={`${r.kind}:${r.id}`} r={r} />)}
    </div>
  );
}

const MAX_REFS = 5;

/** 関連先の簡易ピッカー（記録・予定・ToDo） */
export function RefPicker({ value, onChange }: { value: RelatedRef[]; onChange: (v: RelatedRef[]) => void }) {
  const { familyId, childId } = useFamily();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'event' | 'schedule' | 'task'>('event');
  const events = useCollection<DailyEvent>(open && kind === 'event' && familyId && childId ? query(paths.events(familyId, childId), orderBy('occurredAt', 'desc'), limit(30)) : null);
  const schedules = useCollection<Schedule>(open && kind === 'schedule' && familyId ? paths.schedules(familyId) : null);
  const tasks = useCollection<Task>(open && kind === 'task' && familyId ? paths.tasks(familyId) : null);

  const has = (k: string, id: string) => value.some((r) => r.kind === k && r.id === id);
  const add = (r: RelatedRef) => {
    if (has(r.kind, r.id) || value.length >= MAX_REFS) return;
    onChange([...value, r]);
  };
  type Opt = { ref: RelatedRef; label: string };
  let opts: Opt[] = [];
  if (kind === 'event') {
    opts = events.data.filter((e) => e.status !== 'void').map((e) => ({
      ref: { kind: 'event', id: e.id, childId: childId ?? undefined },
      label: `${formatDateJa(toDateStr(e.occurredAt.toDate()))} ${formatTime(e.occurredAt.toDate())} ${EVENT_LABEL[e.type] ?? e.type}`,
    }));
  } else if (kind === 'schedule') {
    opts = schedules.data.filter((s) => s.status === 'planned').map((s) => ({ ref: { kind: 'schedule', id: s.id }, label: s.title }));
  } else {
    opts = tasks.data.filter((t) => t.status !== 'done').map((t) => ({ ref: { kind: 'task', id: t.id }, label: t.title }));
  }

  return (
    <div className="stack">
      {value.length > 0 && (
        <ul className="pl-list">
          {value.map((r) => (
            <li key={`${r.kind}:${r.id}`} className="row">
              <RefLink r={r} />
              <Button variant="ghost" onClick={() => onChange(value.filter((x) => !(x.kind === r.kind && x.id === r.id)))}>外す</Button>
            </li>
          ))}
        </ul>
      )}
      {!open ? (
        <Button onClick={() => setOpen(true)} disabled={value.length >= MAX_REFS}>関連先を選ぶ</Button>
      ) : (
        <Card>
          <div className="ch-seg" role="radiogroup" aria-label="関連先の種類">
            {(['event', 'schedule', 'task'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={`ch-seg__item${kind === k ? ' is-active' : ''}`} onClick={() => setKind(k)}>
                {REF_KIND[k]}
              </button>
            ))}
          </div>
          {opts.length === 0 ? (
            <p className="muted small">選べる項目がありません。</p>
          ) : (
            <ul className="pl-list">
              {opts.map((o) => (
                <li key={o.ref.id}>
                  <Button block disabled={has(o.ref.kind, o.ref.id)} onClick={() => add(o.ref)}>
                    {has(o.ref.kind, o.ref.id) ? '選択済み：' : ''}{o.label}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button variant="ghost" onClick={() => setOpen(false)}>閉じる</Button>
        </Card>
      )}
    </div>
  );
}
