import { Link } from 'react-router-dom';
import { Button, Card, CategoryIcon, useToast } from '../../components';
import { useAuth, useFamily } from '../../context';
import { api, apiErrorMessage } from '../../lib/api';
import { formatDateLabel, formatTime, todayStr } from '../../lib/time';
import { acknowledgeHandover, useMyAcks, usePlansData } from './data';
import { homeDueTasks, pendingHandoversForMe, todaysSchedules } from './logic/plans';
import { useOnline } from './ui';
import './plans.css';

const HANDOVER_MAX = 2;
const PLAN_MAX = 3;
const SHOP_MAX = 3;

/** 未解決で自分宛て・未確認の申し送り（重要を上、最大2件＋残件数） */
export function HomeHandoversCard() {
  const { user } = useAuth();
  const { familyId, memberName } = useFamily();
  const toast = useToast();
  const { handovers } = usePlansData();
  const { acks, ready } = useMyAcks(familyId, user?.uid ?? null, handovers.map((h) => h.id));
  if (!user || !ready) return null;
  const list = pendingHandoversForMe(handovers, acks, (h) => h.id, user.uid, new Date());
  if (list.length === 0) return null;
  const shown = list.slice(0, HANDOVER_MAX);
  return (
    <Card tone="handover" aria-label="申し送り">
      <div className="stack">
        <div className="pl-card-head">
          <h2 className="pl-head"><span className="pl-head__icon" style={{ background: 'var(--cat-handover-bg)', color: 'var(--cat-handover-fg)' }}><CategoryIcon name="handover" size={20} /></span>申し送り</h2>
          <Link to="/plans?tab=handovers" className="small">すべて見る</Link>
        </div>
        <ul className="pl-list">
          {shown.map((h) => (
            <li key={h.id} className="pl-item">
              <Link className="pl-item__main" to={`/plans/handovers/${h.id}`}>
                <span className="row">
                  {h.priority === 'important' && <span className="pl-badge pl-badge--alert">重要</span>}
                  {ackLabel(h.revision, acks[h.id]?.handoverRevision)}
                  <span className="small muted">{h.createdBy ? `${memberName(h.createdBy)}より` : ''}</span>
                </span>
                <span className="pl-text">{h.text.length > 60 ? `${h.text.slice(0, 60)}…` : h.text}</span>
              </Link>
              <Button
                variant="primary"
                className="pl-check"
                onClick={() => acknowledgeHandover(familyId!, h.id, user.uid, h.revision).catch((e) => toast.show(apiErrorMessage(e), { tone: 'error' }))}
              ><CategoryIcon name="check" size={18} />確認した</Button>
            </li>
          ))}
        </ul>
        {list.length > shown.length && <p className="small muted">ほか {list.length - shown.length} 件</p>}
      </div>
    </Card>
  );
}

function ackLabel(rev: number, ackRev: number | undefined) {
  return ackRev != null && ackRev < rev ? <span className="pl-badge pl-badge--warn">再確認が必要</span> : null;
}

/** 今日の予定と、期限が今日以前の未完了ToDo（本人担当→未担当） */
export function HomeTodayPlansCard() {
  const { user } = useAuth();
  const { memberName } = useFamily();
  const { schedules, tasks, loading } = usePlansData();
  if (!user || loading) return null;
  const today = todayStr();
  const plans = todaysSchedules(schedules, today);
  const due = homeDueTasks(tasks, user.uid, today);
  return (
    <Card aria-label="今日の予定と用事">
      <div className="stack">
        <div className="pl-card-head">
          <h2 className="pl-head"><span className="pl-head__icon" style={{ background: 'var(--cat-schedule-bg)', color: 'var(--cat-schedule-fg)' }}><CategoryIcon name="schedule" size={20} /></span>今日の予定・用事</h2>
          <Link to="/plans" className="small">すべて見る</Link>
        </div>
        {plans.length === 0 && due.length === 0 && <p className="muted small">今日の予定・期限のあるToDoはありません</p>}
        <ul className="pl-list">
          {plans.slice(0, PLAN_MAX).map((s) => (
            <li key={s.id} className="pl-item">
              <Link className="pl-item__main" to={`/plans/schedules/${s.id}`}>
                <span className="pl-item__title">{s.allDay ? '終日' : s.startAt ? formatTime(s.startAt.toDate()) : ''} {s.title}</span>
                {s.location && <span className="small muted">{s.location}</span>}
              </Link>
            </li>
          ))}
          {due.slice(0, PLAN_MAX).map((t) => (
            <li key={t.id} className="pl-item">
              <Link className="pl-item__main" to={`/plans/tasks/${t.id}`}>
                <span className="pl-item__title">{t.title}</span>
                <span className="row small muted">
                  <span className={`pl-badge${t.dueDate! < today ? ' pl-badge--alert' : ' pl-badge--warn'}`}>期限 {formatDateLabel(t.dueDate!)}</span>
                  <span>{t.deadlineVerified ? '確定期限' : '目安（要確認）'}</span>
                  <span>{t.assigneeUid ? `担当：${memberName(t.assigneeUid)}` : '未担当'}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {plans.length > PLAN_MAX || due.length > PLAN_MAX ? (
          <p className="small muted">ほか {Math.max(0, plans.length - PLAN_MAX) + Math.max(0, due.length - PLAN_MAX)} 件</p>
        ) : null}
      </div>
    </Card>
  );
}

/** 買い物の未購入（件数＋上位数件、ワンタップ購入済み） */
export function HomeShoppingCard() {
  const { familyId } = useFamily();
  const toast = useToast();
  const online = useOnline();
  const { shopping, loading } = usePlansData();
  if (loading) return null;
  const needed = shopping.filter((s) => s.status === 'needed');
  if (needed.length === 0) return null;
  const buy = async (id: string, revision: number) => {
    if (!familyId) return;
    try {
      await api.updateDoc({ familyId, kind: 'shopping', docId: id, expectedRevision: revision, patch: { status: 'purchased' } });
    } catch (e) {
      toast.show(apiErrorMessage(e), { tone: 'error' });
    }
  };
  return (
    <Card aria-label="買い物">
      <div className="stack">
        <div className="pl-card-head">
          <h2 className="pl-head"><span className="pl-head__icon" style={{ background: 'var(--cat-shopping-bg)', color: 'var(--cat-shopping-fg)' }}><CategoryIcon name="shopping" size={20} /></span>買い物（{needed.length}件）</h2>
          <Link to="/plans?tab=shopping" className="small">すべて見る</Link>
        </div>
        <ul className="pl-list">
          {needed.slice(0, SHOP_MAX).map((s) => (
            <li key={s.id} className="pl-item">
              <div className="pl-item__main">
                <span className="pl-item__title">{s.name}{s.quantity != null ? ` ×${s.quantity}` : ''}</span>
                <span className="small muted">{[s.brand, s.size].filter(Boolean).join(' ／ ')}</span>
              </div>
              <Button className="pl-check" disabled={!online} aria-label={`${s.name}を購入済みにする`} onClick={() => buy(s.id, s.revision)}>購入済み</Button>
            </li>
          ))}
        </ul>
        {needed.length > SHOP_MAX && <p className="small muted">ほか {needed.length - SHOP_MAX} 件</p>}
      </div>
    </Card>
  );
}
