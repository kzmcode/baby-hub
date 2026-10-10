import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { doc, getDocFromServer, getDocsFromCache, query, waitForPendingWrites, where } from 'firebase/firestore';
import { useAuth } from './AuthContext';
import { paths, useCollection, useDocument } from '../lib/db';
import { accessLossKind, shouldWipeAfterCheck, unsyncedNotice, type MemberCheck } from '../lib/accessLoss';
import { clearLocalData, db } from '../lib/firebase';
import type { Child, Family, FamilyRef, Member, Role } from '../types/models';

interface FamilyValue {
  familyId: string | null;
  family: Family | null;
  role: Role | null;
  members: Member[];
  activeMembers: Member[];
  childId: string | null;
  child: Child | null;
  loading: boolean;
  /** 未設定→「実施者未確認」、退出・削除→「退出したメンバー」 */
  memberName(uid?: string | null): string;
}
const FamilyContext = createContext<FamilyValue | null>(null);

export function FamilyProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const uid = user?.uid ?? null;

  // active な familyRef を 1 つ選ぶ（1ユーザー1有効家族）
  const refs = useCollection<FamilyRef>(uid ? query(paths.familyRefs(uid), where('status', '==', 'active')) : null);
  const familyId = refs.data[0]?.familyId ?? null;
  const role = refs.data[0]?.role ?? null;

  const fam = useDocument<Family>(familyId ? paths.family(familyId) : null);
  const mem = useCollection<Member>(familyId ? paths.members(familyId) : null);
  const kids = useCollection<Child>(familyId ? paths.children(familyId) : null);

  const members = useMemo(() => mem.data.map((m) => ({ ...m, uid: m.uid ?? m.id })) as Member[], [mem.data]);
  const activeMembers = useMemo(() => members.filter((m) => m.status === 'active'), [members]);
  // 退出・除外・家族削除・権限喪失を検知したら、端末の永続キャッシュ（信頼端末）を消して /setup へ
  const hadFamily = useRef(false);
  const wiping = useRef(false);
  const myStatus = uid ? members.find((m) => m.uid === uid)?.status : undefined;
  const errorCodes = [fam.error, mem.error, kids.error].map((e) => (e as { code?: string } | null)?.code);
  const kind = accessLossKind({ hadFamily: hadFamily.current, signedIn: !!uid, familyId, myMemberStatus: myStatus, errorCodes });
  const lost = kind !== 'none';
  const [retryTick, setRetryTick] = useState(0);
  const verifying = useRef(false);
  const firstChildId = kids.data[0]?.id ?? null;
  useEffect(() => {
    if (!uid) { hadFamily.current = false; return; }
    if (familyId && !lost) hadFamily.current = true;
    if (!lost || wiping.current || verifying.current) return;
    const wipe = async () => {
      wiping.current = true;
      // 未同期の書込みがあれば、消去前に知らせる（件数は端末キャッシュ上の未送信イベントを数える。取れなければ件数なし）
      try {
        let hasPending = false;
        await Promise.race([waitForPendingWrites(db).then(() => undefined), new Promise<void>((r) => setTimeout(() => { hasPending = true; r(); }, 1500))]);
        let n: number | null = null;
        if (familyId && firstChildId) {
          try { n = (await getDocsFromCache(paths.events(familyId, firstChildId))).docs.filter((d) => d.metadata.hasPendingWrites).length; } catch { n = null; }
        }
        const msg = unsyncedNotice(n, hasPending || (n ?? 0) > 0);
        if (msg) window.alert(`退出または除外により、この端末のデータを消去します。${msg}`);
      } catch { /* 通知は best-effort */ }
      void clearLocalData().finally(() => window.location.replace('/setup'));
    };
    if (kind === 'definite') { void wipe(); return; }
    // permission-denied だけ: サーバーで自分のメンバー状態を確認してから消去。確認できなければ消さず、あとで再確認する
    if (!familyId) return;
    verifying.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      let check: MemberCheck;
      try {
        const snap = await getDocFromServer(doc(db, 'families', familyId, 'members', uid));
        check = snap.exists() ? { kind: 'status', status: (snap.data() as { status?: string }).status } : { kind: 'missing' };
      } catch {
        check = { kind: 'error' };
      }
      verifying.current = false;
      if (shouldWipeAfterCheck(check)) await wipe();
      else if (check.kind === 'error') timer = setTimeout(() => setRetryTick((t) => t + 1), 15_000);
    })();
    return () => { if (timer) clearTimeout(timer); };
  }, [uid, familyId, lost, kind, retryTick, firstChildId]);

  const childDoc = kids.data.find((c) => c.status === 'active') ?? kids.data[0] ?? null;

  const memberName = useCallback(
    (u?: string | null) => {
      if (!u) return '実施者未確認';
      const m = members.find((x) => x.uid === u);
      if (!m || m.status !== 'active') return '退出したメンバー';
      return m.displayName || '退出したメンバー';
    },
    [members],
  );

  const loading =
    authLoading || (!!uid && refs.loading) || (!!familyId && (fam.loading || mem.loading || kids.loading));

  const value = useMemo<FamilyValue>(
    () => ({
      familyId,
      family: fam.data,
      role,
      members,
      activeMembers,
      childId: childDoc?.id ?? null,
      child: childDoc,
      loading,
      memberName,
    }),
    [familyId, fam.data, role, members, activeMembers, childDoc, loading, memberName],
  );
  return <FamilyContext.Provider value={value}>{children}</FamilyContext.Provider>;
}

export function useFamily(): FamilyValue {
  const v = useContext(FamilyContext);
  if (!v) throw new Error('FamilyProvider が必要です');
  return v;
}
