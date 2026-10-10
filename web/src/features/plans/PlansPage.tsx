import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, CategoryIcon, EmptyState, Sheet, Tabs, useToast } from '../../components';
import { useAuth, useFamily } from '../../context';
import { apiErrorMessage, api } from '../../lib/api';
import { createFamilyDoc, paths } from '../../lib/db';
import { addDaysStr, formatDateLabel, formatTime, todayStr } from '../../lib/time';
import { acknowledgeHandover, useMyAcks, usePlansData } from './data';
import { ScheduleForm, ShoppingForm, TaskForm, HandoverForm } from './forms';
import { ackState, compareHandovers, compareTasks, groupSchedules, isExpired, isForMe, taskUrgency } from './logic/plans';
import { buildTemplateTask, missingTemplates } from './logic/templates';
import { handoverCreate, scheduleCreate, shoppingCreate, taskCreate } from './payload';
import type { PHandover, PlanTab, PSchedule, PShopping, PTask } from './types';
import { ConfirmSheet, OfflineNotice, SCHEDULE_CATEGORY, TASK_CATEGORY, useOnline } from './ui';
import './plans.css';

const TABS: PlanTab[] = ['schedules', 'tasks', 'shopping', 'handovers'];

export function PlansPage() {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab');
  const tab: PlanTab = TABS.includes(raw as PlanTab) ? (raw as PlanTab) : 'schedules';
  const { user } = useAuth();
  const { familyId } = useFamily();
  const data = usePlansData();
  const { acks } = useMyAcks(familyId, user?.uid ?? null, data.handovers.map((h) => h.id));
  const now = new Date();
  const unackCount = user
    ? data.handovers.filter((h) => h.status === 'open' && !isExpired(h, now) && isForMe(h, user.uid) && ackState(h, acks[h.id]) !== 'acked').length
    : 0;
  const openTasks = data.tasks.filter((t) => t.status !== 'done').length;
  const needed = data.shopping.filter((s) => s.status === 'needed').length;

  return (
    <div className="page">
      <h1 className="sr-only">予定・用事</h1>
      <Tabs
        ariaLabel="予定・用事"
        value={tab}
        onChange={(k) => setSp({ tab: k }, { replace: true })}
        tabs={[
          { key: 'schedules', label: '予定' },
          { key: 'tasks', label: 'ToDo', badge: openTasks || undefined },
          { key: 'shopping', label: '買い物', badge: needed || undefined },
          { key: 'handovers', label: '申し送り', badge: unackCount || undefined },
        ]}
      />
      {data.error && <p className="ch-field__error" role="alert">読み込めませんでした。接続を確認してください。</p>}
      {tab === 'schedules' && <SchedulesTab list={data.schedules} />}
      {tab === 'tasks' && <TasksTab list={data.tasks} />}
      {tab === 'shopping' && <ShoppingTab list={data.shopping} />}
      {tab === 'handovers' && <HandoversTab list={data.handovers} acks={acks} />}
    </div>
  );
}

/** 作成シートの共通処理 */
function useCreate(onDone: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      toast.show(okMsg);
      onDone();
    } catch (e) {
      toast.show(apiErrorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

// ---------- 予定 ----------
function SchedulesTab({ list }: { list: PSchedule[] }) {
  const { familyId } = useFamily();
  const [open, setOpen] = useState(false);
  const { busy, run } = useCreate(() => setOpen(false));
  const today = todayStr();
  const g = useMemo(() => groupSchedules(list, today), [list, today]);
  const online = useOnline();
  return (
    <div className="stack">
      <div className="pl-addbar"><Button variant="primary" onClick={() => setOpen(true)}><CategoryIcon name="plus" size={18} /> 予定を追加</Button></div>
      {list.length === 0 && <EmptyState icon="schedule" title="予定はまだありません" description="受診や手続きの日時を登録できます" />}
      <DayBlock label="今日" items={g.today} />
      <DayBlock label="明日" items={g.tomorrow} />
      {g.later.map((d) => <DayBlock key={d.date} label={formatDateLabel(d.date)} items={d.items} />)}
      <DayBlock label="日付未設定" items={g.undated} />
      {g.past.length > 0 && (
        <details className="pl-details">
          <summary>過去の予定（{g.past.reduce((n, d) => n + d.items.length, 0)}件）</summary>
          {g.past.map((d) => <DayBlock key={d.date} label={formatDateLabel(d.date)} items={d.items} />)}
        </details>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="予定を追加">
        {!online && <OfflineNotice />}
        <ScheduleForm submitLabel="追加する" busy={busy} onSubmit={(v) => familyId && run(async () => { const id = await createFamilyDoc(paths.schedules(familyId).path, scheduleCreate(v)); void api.syncScheduleReminder({ familyId, scheduleId: id }).catch(() => {}); }, '予定を追加しました')} />
      </Sheet>
    </div>
  );
}

function DayBlock({ label, items }: { label: string; items: PSchedule[] }) {
  const { memberName } = useFamily();
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="pl-day">{label}</h2>
      <ul className="pl-list">
        {items.map((s) => (
          <li key={s.id} className={`pl-item${s.status !== 'planned' ? ' pl-item--done' : ''}`}>
            <Link className="pl-item__main" to={`/plans/schedules/${s.id}`}>
              <span className="pl-item__title">{s.title}</span>
              <span className="small muted">
                {s.allDay ? '終日' : s.startAt ? `${formatTime(s.startAt.toDate())}${s.endAt ? `〜${formatTime(s.endAt.toDate())}` : ''}` : ''}
                {s.location ? ` ／ ${s.location}` : ''}
              </span>
              <span className="row">
                <span className="pl-badge">{SCHEDULE_CATEGORY[s.category]}</span>
                {s.status === 'done' && <span className="pl-badge pl-badge--ok">完了</span>}
                {s.status === 'cancelled' && <span className="pl-badge">中止</span>}
                {s.assigneeUids.length > 0 && <span className="small muted">担当：{s.assigneeUids.map((u) => memberName(u)).join('・')}</span>}
                {s._pending && <span className="small muted">未同期</span>}
              </span>
              {s.preparation && <span className="small">準備：{s.preparation}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- ToDo ----------
export function TaskRow({ t }: { t: PTask }) {
  const { memberName } = useFamily();
  const toast = useToast();
  const { familyId } = useFamily();
  const online = useOnline();
  const today = todayStr();
  const urg = taskUrgency(t, today);
  const done = t.status === 'done';
  const toggle = async () => {
    if (!familyId) return;
    try {
      await api.updateDoc({ familyId, kind: 'task', docId: t.id, expectedRevision: t.revision, patch: { status: done ? 'todo' : 'done' } });
    } catch (e) {
      toast.show(apiErrorMessage(e), { tone: 'error' });
    }
  };
  return (
    <li className={`pl-item${done ? ' pl-item--done' : ''}`}>
      <Link className="pl-item__main" to={`/plans/tasks/${t.id}`}>
        <span className="pl-item__title">{t.title}</span>
        <span className="row">
          <span className="pl-badge">{TASK_CATEGORY[t.category]}</span>
          {t.status === 'doing' && <span className="pl-badge pl-badge--warn">進行中</span>}
          {t.dueDate && (
            <span className={`pl-badge${urg === 'overdue' ? ' pl-badge--alert' : urg === 'today' ? ' pl-badge--warn' : ''}`}>
              期限 {formatDateLabel(t.dueDate)}{urg === 'overdue' ? '（超過）' : ''}・{t.deadlineVerified ? '確定期限' : '目安（要確認）'}
            </span>
          )}
          <span className="small muted">{t.assigneeUid ? `担当：${memberName(t.assigneeUid)}` : '未担当'}</span>
          {t.step && <span className="small muted">段階：{t.step}</span>}
        </span>
      </Link>
      <Button className="pl-check" aria-label={done ? `${t.title}を未完了に戻す` : `${t.title}を完了にする`} disabled={!online} onClick={toggle}>
        {done ? '戻す' : '完了'}
      </Button>
    </li>
  );
}

function TasksTab({ list }: { list: PTask[] }) {
  const { familyId, child } = useFamily();
  const [open, setOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const { busy, run } = useCreate(() => setOpen(false));
  const online = useOnline();
  const sorted = useMemo(() => [...list].sort(compareTasks), [list]);
  const active = sorted.filter((t) => t.status !== 'done');
  const done = sorted.filter((t) => t.status === 'done');
  return (
    <div className="stack">
      <div className="pl-addbar">
        <Button variant="primary" onClick={() => setOpen(true)}><CategoryIcon name="plus" size={18} /> ToDoを追加</Button>
        <Button onClick={() => setTplOpen(true)}>出生後の手続きを追加</Button>
      </div>
      {list.length === 0 && <EmptyState icon="task" title="ToDoはまだありません" description="出生後の手続き候補をまとめて追加することもできます" />}
      <ul className="pl-list">{active.map((t) => <TaskRow key={t.id} t={t} />)}</ul>
      {done.length > 0 && (
        <details className="pl-details">
          <summary>完了したToDo（{done.length}件）</summary>
          <ul className="pl-list">{done.map((t) => <TaskRow key={t.id} t={t} />)}</ul>
        </details>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="ToDoを追加">
        {!online && <OfflineNotice />}
        <TaskForm submitLabel="追加する" busy={busy} onSubmit={(v) => familyId && run(() => createFamilyDoc(paths.tasks(familyId).path, taskCreate(v)), 'ToDoを追加しました')} />
      </Sheet>
      <TemplateSheet open={tplOpen} onClose={() => setTplOpen(false)} existing={list.map((t) => t.title)} birthDate={child?.birthDate ?? null} />
    </div>
  );
}

function TemplateSheet({ open, onClose, existing, birthDate }: { open: boolean; onClose: () => void; existing: string[]; birthDate: string | null }) {
  const { familyId } = useFamily();
  const online = useOnline();
  const cands = missingTemplates(existing);
  const [off, setOff] = useState<Set<string>>(new Set());
  const { busy, run } = useCreate(onClose);
  const chosen = cands.filter((c) => !off.has(c.key));
  const add = () =>
    familyId &&
    run(async () => {
      for (const t of chosen) await createFamilyDoc(paths.tasks(familyId).path, taskCreate(buildTemplateTask(t, birthDate, addDaysStr) as never));
    }, `${chosen.length}件の手続きを追加しました`);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="出生後の手続き候補"
      footer={
        <div className="stack">
          {!online && <OfflineNotice />}
          <Button variant="primary" block loading={busy} disabled={!online || chosen.length === 0} onClick={add}>選んだ{chosen.length}件を追加</Button>
        </div>
      }
    >
      <div className="stack">
        <p className="small">全国共通の説明にもとづく候補です。<strong>期限は自治体・加入先・勤務先によって異なるため、必ず公式の案内で確認してください。</strong>追加されるToDoの期限は「目安（要確認）」で、確定期限ではありません。申請済みは受理済みを意味しません。</p>
        {!birthDate && <p className="small muted">出生日が未設定のため、期限の目安は入りません。</p>}
        {cands.length === 0 && <p className="muted">候補はすべて追加済みです。</p>}
        {cands.map((c) => (
          <label key={c.key} className="pl-checkrow">
            <input type="checkbox" checked={!off.has(c.key)} onChange={(e) => setOff((s) => { const n = new Set(s); if (e.target.checked) n.delete(c.key); else n.add(c.key); return n; })} />
            <span>
              <strong>{c.title}</strong>
              <span className="small muted" style={{ display: 'block' }}>{c.basis}</span>
            </span>
          </label>
        ))}
      </div>
    </Sheet>
  );
}

// ---------- 買い物 ----------
export function ShoppingRow({ s }: { s: PShopping }) {
  const { familyId, memberName } = useFamily();
  const toast = useToast();
  const online = useOnline();
  const purchased = s.status === 'purchased';
  const toggle = async () => {
    if (!familyId) return;
    try {
      await api.updateDoc({ familyId, kind: 'shopping', docId: s.id, expectedRevision: s.revision, patch: { status: purchased ? 'needed' : 'purchased' } });
    } catch (e) {
      toast.show(apiErrorMessage(e), { tone: 'error' });
    }
  };
  return (
    <li className={`pl-item${purchased ? ' pl-item--done' : ''}`}>
      <div className="pl-item__main">
        <span className="pl-item__title">{s.name}{s.quantity != null ? ` ×${s.quantity}` : ''}</span>
        <span className="small muted">
          {[s.brand, s.size].filter(Boolean).join(' ／ ')}
          {s.assigneeUid ? `${s.brand || s.size ? ' ／ ' : ''}購入担当：${memberName(s.assigneeUid)}` : ''}
        </span>
      </div>
      <Button className="pl-check" disabled={!online} onClick={toggle} aria-label={purchased ? `${s.name}を未購入に戻す` : `${s.name}を購入済みにする`}>
        {purchased ? '戻す' : '購入済み'}
      </Button>
    </li>
  );
}

function ShoppingTab({ list }: { list: PShopping[] }) {
  const { familyId } = useFamily();
  const toast = useToast();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { busy, run } = useCreate(() => setOpen(false));
  const needed = list.filter((s) => s.status === 'needed');
  const purchased = list.filter((s) => s.status === 'purchased');
  const delPurchased = async () => {
    if (!familyId) return;
    setDeleting(true);
    let failed = 0;
    for (const s of purchased) {
      try {
        await api.deleteDoc({ familyId, kind: 'shopping', docId: s.id, expectedRevision: s.revision });
      } catch { failed++; }
    }
    setDeleting(false);
    setConfirm(false);
    toast.show(failed ? `${failed}件を削除できませんでした` : '購入済みを削除しました', failed ? { tone: 'error' } : undefined);
  };
  return (
    <div className="stack">
      <div className="pl-addbar"><Button variant="primary" onClick={() => setOpen(true)}><CategoryIcon name="plus" size={18} /> 買い物を追加</Button></div>
      {needed.length === 0 && <EmptyState icon="shopping" title="買うものはありません" />}
      <ul className="pl-list">{needed.map((s) => <ShoppingRow key={s.id} s={s} />)}</ul>
      {purchased.length > 0 && (
        <section className="stack">
          <div className="pl-card-head">
            <h2 className="pl-day">購入済み（{purchased.length}件）</h2>
            <Button variant="danger" disabled={!online} onClick={() => setConfirm(true)}>購入済みを削除</Button>
          </div>
          <ul className="pl-list">{purchased.map((s) => <ShoppingRow key={s.id} s={s} />)}</ul>
        </section>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="買い物を追加">
        {!online && <OfflineNotice />}
        <ShoppingForm submitLabel="追加する" busy={busy} onSubmit={(v) => familyId && run(() => createFamilyDoc(paths.shopping(familyId).path, shoppingCreate(v)), '買い物を追加しました')} />
      </Sheet>
      <ConfirmSheet open={confirm} title="購入済みを削除" message={`購入済みの${purchased.length}件を削除します。元に戻せません。`} confirmLabel="削除する" busy={deleting} onConfirm={delPurchased} onClose={() => setConfirm(false)} />
    </div>
  );
}

// ---------- 申し送り ----------
function HandoversTab({ list, acks }: { list: PHandover[]; acks: Record<string, { handoverRevision: number } | null> }) {
  const { familyId } = useFamily();
  const [open, setOpen] = useState(false);
  const { busy, run } = useCreate(() => setOpen(false));
  const online = useOnline();
  const openList = [...list.filter((h) => h.status === 'open')].sort(compareHandovers);
  const resolved = list.filter((h) => h.status === 'resolved').sort((a, b) => b.createdAtMs - a.createdAtMs);
  return (
    <div className="stack">
      <div className="pl-addbar"><Button variant="primary" onClick={() => setOpen(true)}><CategoryIcon name="plus" size={18} /> 申し送りを追加</Button></div>
      {openList.length === 0 && <EmptyState icon="handover" title="未解決の申し送りはありません" />}
      <ul className="pl-list">{openList.map((h) => <HandoverRow key={h.id} h={h} ack={acks[h.id]} />)}</ul>
      {resolved.length > 0 && (
        <details className="pl-details">
          <summary>解決済み（{resolved.length}件）</summary>
          <ul className="pl-list">{resolved.map((h) => <HandoverRow key={h.id} h={h} ack={acks[h.id]} />)}</ul>
        </details>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="申し送りを追加">
        {!online && <OfflineNotice />}
        <HandoverForm submitLabel="送る" busy={busy} onSubmit={(v) => familyId && run(async () => { const id = await createFamilyDoc(paths.handovers(familyId).path, handoverCreate(v)); void api.notifyHandoverCreated({ familyId, handoverId: id }).catch(() => {}); }, '申し送りを追加しました')} />
      </Sheet>
    </div>
  );
}

export function AckStatusBadge({ state }: { state: ReturnType<typeof ackState> }) {
  return state === 'acked' ? <span className="pl-badge pl-badge--ok">確認済み</span>
    : state === 'stale' ? <span className="pl-badge pl-badge--warn">再確認が必要</span>
    : <span className="pl-badge pl-badge--alert">未確認</span>;
}

function HandoverRow({ h, ack }: { h: PHandover; ack: { handoverRevision: number } | null | undefined }) {
  const { user } = useAuth();
  const { familyId, memberName } = useFamily();
  const toast = useToast();
  const mine = !!user && isForMe(h, user.uid);
  const state = ackState(h, ack);
  const resolved = h.status === 'resolved';
  const doAck = () => {
    if (!familyId || !user) return;
    acknowledgeHandover(familyId, h.id, user.uid, h.revision).catch((e) => toast.show(apiErrorMessage(e), { tone: 'error' }));
  };
  return (
    <li className="pl-item pl-item--handover">
      <Link className="pl-item__main" to={`/plans/handovers/${h.id}`}>
        <span className="row">
          {h.priority === 'important' && <span className="pl-badge pl-badge--alert">重要</span>}
          {resolved ? <span className="pl-badge pl-badge--ok">解決済み</span> : mine && <AckStatusBadge state={state} />}
          <span className="small muted">{h.createdBy ? `${memberName(h.createdBy)}より` : ''}</span>
        </span>
        <span className="pl-item__title pl-text">{h.text.length > 80 ? `${h.text.slice(0, 80)}…` : h.text}</span>
      </Link>
      {!resolved && mine && state !== 'acked' && <Button className="pl-check" onClick={doAck}>確認</Button>}
    </li>
  );
}
