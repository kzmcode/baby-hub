import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { useAuth, useFamily } from '../context';
import { EventDetailPage, HomePage, RecordsPage } from '../features/records';
import { HandoverDetailPage, PlansPage, ScheduleDetailPage, TaskDetailPage } from '../features/plans';
import { HealthPage, HealthRoutes } from '../features/health';
import { INVITE_STORAGE_KEY, stashInviteFromLocation } from '../features/account/logic/invite';
import { JoinPage, LoginPage, MorePage, MoreRoutes, SetupPage } from '../features/account';
import { isSetupInFlight } from '../features/account/util';

function Loading() {
  return <div className="ch-center muted" role="status">読み込み中…</div>;
}

/**
 * 未ログイン→/login。戻り先を state.from に保持する。招待トークン（#token=）は history.state に残さず
 * sessionStorage('ch.inviteToken') へ退避し、from にはハッシュを含めない（JoinPage が sessionStorage から読む）。
 */
function RequireAuth() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) {
    const from = stashInviteFromLocation(loc, (t) => { try { sessionStorage.setItem(INVITE_STORAGE_KEY, t); } catch { /* ignore */ } });
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return <Outlet />;
}

/** 家族未所属→/setup */
function RequireFamily() {
  const { familyId, loading } = useFamily();
  if (loading) return <Loading />;
  if (!familyId) return <Navigate to="/setup" replace />;
  return <Outlet />;
}

/** ログイン済みなら行き先を決めて転送（/login 用） */
function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const { familyId, loading: fl } = useFamily();
  const loc = useLocation();
  if (loading || (user && fl)) return <Loading />;
  if (user) {
    const from = (loc.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? (familyId ? '/' : '/setup')} replace />;
  }
  return <>{children}</>;
}

/** 所属済みなら /setup へ入らない */
function SetupGuard({ children }: { children: ReactNode }) {
  const { familyId, loading } = useFamily();
  // 作成〜招待発行の途中は SetupPage 自身が遷移先を決める（読み込み表示に切り替えると SetupPage が外れてしまう）
  if (isSetupInFlight()) return <>{children}</>;
  if (loading) return <Loading />;
  if (familyId) {
    // 作成直後は SetupPage が招待を sessionStorage('ch.setupInvite') に保存して /more/family へ移動する。
    // ガードが先に '/' へ飛ばして招待表示を失わないよう、保存済みならそちらへ転送する。
    let hasInvite = false;
    try { hasInvite = !!sessionStorage.getItem('ch.setupInvite'); } catch { /* ignore */ }
    return <Navigate to={hasInvite ? '/more/family' : '/'} replace />;
  }
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<RedirectIfAuthed><LoginPage /></RedirectIfAuthed>} />
      <Route element={<RequireAuth />}>
        <Route path="/setup" element={<SetupGuard><SetupPage /></SetupGuard>} />
        {/* 招待参加は未所属でも可（所属済みの扱いは JoinPage/acceptInvite が案内） */}
        <Route path="/join" element={<JoinPage />} />
        <Route element={<RequireFamily />}>
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/records" element={<RecordsPage />} />
            <Route path="/records/:eventId" element={<EventDetailPage />} />
            <Route path="/plans" element={<PlansPage />} />
            <Route path="/plans/schedules/:id" element={<ScheduleDetailPage />} />
            <Route path="/plans/tasks/:id" element={<TaskDetailPage />} />
            <Route path="/plans/handovers/:id" element={<HandoverDetailPage />} />
            <Route path="/health" element={<HealthPage />} />
            <Route path="/health/*" element={<HealthRoutes />} />
            <Route path="/more" element={<MorePage />} />
            <Route path="/more/*" element={<MoreRoutes />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
