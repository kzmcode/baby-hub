import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { doc } from 'firebase/firestore';
import { Button, Card, CategoryIcon, ConflictNotice, EmptyState, useToast } from '../../components';
import { useAuth, useFamily } from '../../context';
import { api, apiErrorMessage, toApiError, type DeletableKind, type DocKind } from '../../lib/api';
import { paths, useCollection, useDocument } from '../../lib/db';
import { safeHttpsUrl } from '../../lib/safeUrl';
import { formatDateJa, formatDateLabel, formatTime, toDateStr } from '../../lib/time';
import type { Ack, Audit, Handover, Schedule, Task } from '../../types/models';
import { acknowledgeHandover } from './data';
import { HandoverForm, ScheduleForm, TaskForm } from './forms';
import { ackState, isExpired, isForMe, taskUrgency } from './logic/plans';
import { handoverPatch, schedulePatch, taskPatch } from './payload';
import type { PHandover, PSchedule, PTask } from './types';
import { ConfirmSheet, OfflineNotice, RefList, SCHEDULE_CATEGORY, TASK_CATEGORY, TASK_STATUS, useOnline } from './ui';
import { AckStatusBadge } from './PlansPage';
import './plans.css';

function BackLink({ tab }: { tab: string }) {
  return <Link to={`/plans?tab=${tab}`} className="row"><CategoryIcon name="chevronLeft" size={18} />一覧へ戻る</Link>;
}

/** 更新・削除の共通処理（楽観ロック競合は conflict に保持し、入力はフォーム側に残す） */
function useDocActions(kind: DocKind, docId: string, revision: number | undefined, backTab: string) {
  const { familyId } = useFamily();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = async (patch: Record<string, unknown>, okMsg?: string): Promise<boolean> => {
    if (!familyId || revision == null) return false;
    setBusy(true);
    try {
      await api.updateDoc({ familyId, kind, docId, expectedRevision: revision, patch });
      setConflict(false);
      if (okMsg) toast.show(okMsg);
      return true;
    } catch (e) {
      if (toApiError(e).isConflict) setConflict(true);
      else toast.show(apiErrorMessage(e), { tone: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!familyId || revision == null) return;
    setBusy(true);
    try {
      await api.deleteDoc({ familyId, kind: kind as DeletableKind, docId, expectedRevision: revision });
      toast.show('削除しました');
      navigate(`/plans?tab=${backTab}`, { replace: true });
    } catch (e) {
      setConfirmDelete(false);
      if (toApiError(e).isConflict) setConflict(true);
      else toast.show(apiErrorMessage(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return { busy, conflict, setConflict, update, remove, confirmDelete, setConfirmDelete };
}

function Loading({ loading, missing, tab }: { loading: boolean; missing: boolean; tab: string }) {
  if (loading) return <div className="page"><p className="muted">読み込み中…</p></div>;
  if (missing) return <div className="page"><BackLink tab={tab} /><EmptyState title="見つかりません" description="削除されたか、アクセスできない可能性があります" /></div>;
  return null;
}

function DeleteButton({ onClick }: { onClick: () => void }) {
  const online = useOnline();
  return <Button variant="danger" disabled={!online} onClick={onClick}>削除</Button>;
}

interface ShellProps { title: string; tab: string; children: ReactNode }
function Shell({ title, tab, children }: ShellProps) {
  return (
    <div className="page">
      <BackLink tab={tab} />
      <h1>{title}</h1>
      {children}
    </div>
  );
}

// ---------- 予定詳細（S07） ----------
export function ScheduleDetailPage() {
  const { id = '' } = useParams();
  const { familyId, memberName } = useFamily();
  const online = useOnline();
  const { data, loading } = useDocument<Schedule & Audit>(familyId ? doc(paths.schedules(familyId), id) : null);
  const s = data as PSchedule | null;
  const act = useDocActions('schedule', id, s?.revision, 'schedules');
  const [editing, setEditing] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const gate = Loading({ loading, missing: !s, tab: 'schedules' });
  if (gate || !s) return gate;

  const when = s.allDay
    ? `${s.date ? formatDateJa(s.date) : ''} 終日`
    : s.startAt ? `${formatDateJa(toDateStr(s.startAt.toDate()))} ${formatTime(s.startAt.toDate())}${s.endAt ? `〜${formatTime(s.endAt.toDate())}` : ''}` : '';

  const view = (
    <Card>
      <div className="stack">
        <div className="row">
          <span className="pl-badge">{SCHEDULE_CATEGORY[s.category]}</span>
          {s.status === 'done' && <span className="pl-badge pl-badge--ok">完了</span>}
          {s.status === 'cancelled' && <span className="pl-badge">中止</span>}
        </div>
        <p><strong>{when}</strong></p>
        {s.location && <p>場所：{s.location}</p>}
        <p>担当：{s.assigneeUids.length ? s.assigneeUids.map((u) => memberName(u)).join('・') : '未設定'}</p>
        {s.preparation && <p className="pl-text">準備物：{s.preparation}</p>}
        <RefList refs={s.relatedRefs} />
      </div>
    </Card>
  );

  return (
    <Shell title={s.title} tab="schedules">
      {!editing ? (
        <>
          {act.conflict && <ConflictNotice message="他の人が先に更新しました。最新の内容を表示しています。" />}
          {view}
          {!online && <OfflineNotice />}
          <div className="pl-actions">
            <Button variant="primary" disabled={!online} onClick={() => { act.setConflict(false); setEditing(true); }}>編集</Button>
            {s.status !== 'done' ? <Button disabled={!online} loading={act.busy} onClick={() => act.update({ status: 'done' }, '完了にしました')}>完了にする</Button>
              : <Button disabled={!online} loading={act.busy} onClick={() => act.update({ status: 'planned' })}>予定に戻す</Button>}
            {s.status === 'planned' && <Button disabled={!online} onClick={() => act.update({ status: 'cancelled' }, '中止にしました')}>中止にする</Button>}
            <DeleteButton onClick={() => act.setConfirmDelete(true)} />
          </div>
        </>
      ) : (
        <>
          {showLatest && view}
          <ScheduleForm
            initial={s}
            submitLabel="保存する"
            busy={act.busy}
            notice={act.conflict && <ConflictNotice onShowLatest={() => setShowLatest((v) => !v)} />}
            onSubmit={async (v) => { if (await act.update(schedulePatch(v), '保存しました')) setEditing(false); }}
          />
          <Button variant="ghost" onClick={() => { setEditing(false); act.setConflict(false); }}>編集をやめる</Button>
        </>
      )}
      <ConfirmSheet open={act.confirmDelete} title="予定を削除" message="この予定を削除します。元に戻せません。" confirmLabel="削除する" busy={act.busy} onConfirm={act.remove} onClose={() => act.setConfirmDelete(false)} />
    </Shell>
  );
}

// ---------- Task詳細（S07） ----------
export function TaskDetailPage() {
  const { id = '' } = useParams();
  const { familyId, memberName } = useFamily();
  const online = useOnline();
  const { data, loading } = useDocument<Task & Audit>(familyId ? doc(paths.tasks(familyId), id) : null);
  const t = data as PTask | null;
  const act = useDocActions('task', id, t?.revision, 'tasks');
  const [editing, setEditing] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const gate = Loading({ loading, missing: !t, tab: 'tasks' });
  if (gate || !t) return gate;
  const urg = taskUrgency(t, toDateStr(new Date()));

  const view = (
    <Card>
      <div className="stack">
        <div className="row">
          <span className="pl-badge">{TASK_CATEGORY[t.category]}</span>
          <span className={`pl-badge${t.status === 'done' ? ' pl-badge--ok' : ''}`}>{TASK_STATUS[t.status]}</span>
        </div>
        <p>担当：{t.assigneeUid ? memberName(t.assigneeUid) : '未担当'}</p>
        {t.dueDate ? (
          <p>
            期限：<strong>{formatDateJa(t.dueDate)}</strong>{' '}
            <span className={`pl-badge${urg === 'overdue' ? ' pl-badge--alert' : ''}`}>{t.deadlineVerified ? '確定期限' : '目安（要確認）'}</span>
            {urg === 'overdue' && <span className="pl-badge pl-badge--alert">期限超過</span>}
          </p>
        ) : <p className="muted">期限：なし</p>}
        {t.deadlineBasis && <p className="pl-text small">期限の根拠：{t.deadlineBasis}</p>}
        {t.step && <p className="pl-text">手続きの段階：{t.step}</p>}
        {safeHttpsUrl(t.sourceUrl) && <p><a href={safeHttpsUrl(t.sourceUrl)!} target="_blank" rel="noopener noreferrer">公式ページを開く</a>{t.sourceCheckedAt ? `（確認日 ${t.sourceCheckedAt}）` : ''}</p>}
        <RefList refs={t.relatedRefs} />
      </div>
    </Card>
  );

  return (
    <Shell title={t.title} tab="tasks">
      {!editing ? (
        <>
          {act.conflict && <ConflictNotice message="他の人が先に更新しました。最新の内容を表示しています。" />}
          {view}
          {!online && <OfflineNotice />}
          <div className="pl-actions">
            <Button variant="primary" disabled={!online} onClick={() => { act.setConflict(false); setEditing(true); }}>編集</Button>
            {t.status !== 'done' ? (
              <>
                {t.status === 'todo' && <Button disabled={!online} loading={act.busy} onClick={() => act.update({ status: 'doing' })}>進行中にする</Button>}
                <Button disabled={!online} loading={act.busy} onClick={() => act.update({ status: 'done' }, '完了にしました')}>完了にする</Button>
              </>
            ) : <Button disabled={!online} loading={act.busy} onClick={() => act.update({ status: 'todo' })}>未完了に戻す</Button>}
            <DeleteButton onClick={() => act.setConfirmDelete(true)} />
          </div>
        </>
      ) : (
        <>
          {showLatest && view}
          <TaskForm
            initial={t}
            submitLabel="保存する"
            busy={act.busy}
            notice={act.conflict && <ConflictNotice onShowLatest={() => setShowLatest((v) => !v)} />}
            onSubmit={async (v) => { if (await act.update(taskPatch(v), '保存しました')) setEditing(false); }}
          />
          <Button variant="ghost" onClick={() => { setEditing(false); act.setConflict(false); }}>編集をやめる</Button>
        </>
      )}
      <ConfirmSheet open={act.confirmDelete} title="ToDoを削除" message="このToDoを削除します。元に戻せません。" confirmLabel="削除する" busy={act.busy} onConfirm={act.remove} onClose={() => act.setConfirmDelete(false)} />
    </Shell>
  );
}

// ---------- 申し送り詳細（S08） ----------
export function HandoverDetailPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { familyId, memberName } = useFamily();
  const toast = useToast();
  const online = useOnline();
  const { data, loading } = useDocument<Handover & Audit>(familyId ? paths.handover(familyId, id) : null);
  const acksState = useCollection<Ack>(familyId ? paths.acks(familyId, id) : null);
  const h = data ? ({ ...data, createdAtMs: data.createdAt?.toMillis?.() ?? Date.now() } as PHandover) : null;
  const act = useDocActions('handover', id, h?.revision, 'handovers');
  const [editing, setEditing] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const gate = Loading({ loading, missing: !h, tab: 'handovers' });
  if (gate || !h) return gate;

  const acks = acksState.data;
  const myAck = acks.find((a) => a.id === user?.uid) ?? null;
  const mine = !!user && isForMe(h, user.uid);
  const state = ackState(h, myAck);
  const resolved = h.status === 'resolved';
  const recipients = h.recipientUids.length ? h.recipientUids.map((u) => memberName(u)).join('・') : '全員';
  const doAck = () => {
    if (!familyId || !user) return;
    acknowledgeHandover(familyId, h.id, user.uid, h.revision).catch((e) => toast.show(apiErrorMessage(e), { tone: 'error' }));
  };

  const view = (
    <Card tone="handover">
      <div className="stack">
        <div className="row">
          {h.priority === 'important' ? <span className="pl-badge pl-badge--alert">重要</span> : <span className="pl-badge">通常</span>}
          {resolved ? <span className="pl-badge pl-badge--ok">解決済み</span> : <span className="pl-badge">未解決</span>}
          {h.expiresAt && <span className="pl-badge">期限 {formatDateLabel(toDateStr(h.expiresAt.toDate()))}{isExpired(h, new Date()) ? '（過ぎています）' : ''}</span>}
        </div>
        <p className="pl-text">{h.text}</p>
        <p className="small muted">{h.createdBy ? `${memberName(h.createdBy)} から` : ''} ／ 宛先：{recipients}</p>
        <RefList refs={h.relatedRefs} />
        {resolved && h.resolvedBy && <p className="small">{memberName(h.resolvedBy)} が解決にしました</p>}
      </div>
    </Card>
  );

  // 確認者一覧（宛先の有効メンバー）
  const ackRows = h.recipientUids.length ? h.recipientUids : acks.map((a) => a.id);

  return (
    <Shell title="申し送り" tab="handovers">
      {!editing ? (
        <>
          {act.conflict && <ConflictNotice message="他の人が先に更新しました。最新の内容を表示しています。" />}
          {view}
          <Card>
            <h2 className="pl-day">確認状況</h2>
            <p className="small muted">「確認」は読んだことの記録で、対応の完了（解決）とは別です。</p>
            <ul className="pl-list">
              {ackRows.length === 0 && <li className="muted small">まだ誰も確認していません</li>}
              {ackRows.map((uid) => {
                const a = acks.find((x) => x.id === uid);
                const st = ackState(h, a);
                return (
                  <li key={uid} className="row">
                    <strong>{memberName(uid)}</strong>
                    <AckStatusBadge state={st} />
                    {a?.acknowledgedAt && <span className="small muted">{formatDateLabel(toDateStr(a.acknowledgedAt.toDate()))} {formatTime(a.acknowledgedAt.toDate())}</span>}
                  </li>
                );
              })}
            </ul>
          </Card>
          {state === 'stale' && mine && !resolved && <ConflictNotice message="内容が変更されました。もう一度確認してください。" />}
          {!online && <OfflineNotice />}
          <div className="pl-actions">
            {mine && !resolved && state !== 'acked' && <Button variant="primary" onClick={doAck}>{state === 'stale' ? '変更を確認した' : '確認した'}</Button>}
            {mine && state === 'acked' && !resolved && <span className="pl-badge pl-badge--ok">あなたは確認済みです</span>}
            {!resolved ? <Button disabled={!online} loading={act.busy} onClick={() => act.update({ status: 'resolved' }, '解決済みにしました')}>解決済みにする</Button>
              : <Button disabled={!online} loading={act.busy} onClick={() => act.update({ status: 'open' })}>未解決に戻す</Button>}
            <Button disabled={!online} onClick={() => { act.setConflict(false); setEditing(true); }}>編集</Button>
            <DeleteButton onClick={() => act.setConfirmDelete(true)} />
          </div>
        </>
      ) : (
        <>
          {showLatest && view}
          <HandoverForm
            initial={h}
            submitLabel="保存する"
            busy={act.busy}
            notice={act.conflict && <ConflictNotice onShowLatest={() => setShowLatest((v) => !v)} />}
            onSubmit={async (v) => { if (await act.update(handoverPatch(v), '保存しました。相手には再確認が必要と表示されます')) setEditing(false); }}
          />
          <Button variant="ghost" onClick={() => { setEditing(false); act.setConflict(false); }}>編集をやめる</Button>
        </>
      )}
      <ConfirmSheet open={act.confirmDelete} title="申し送りを削除" message="この申し送りと確認状況を削除します。元に戻せません。" confirmLabel="削除する" busy={act.busy} onConfirm={act.remove} onClose={() => act.setConfirmDelete(false)} />
    </Shell>
  );
}
