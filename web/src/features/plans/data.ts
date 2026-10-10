import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { useFamily } from '../../context';
import { paths, useCollection } from '../../lib/db';
import type { Ack, Audit, Handover, Schedule, ShoppingItem, Task } from '../../types/models';
import type { PHandover, PSchedule, PShopping, PTask } from './types';

export function usePlansData() {
  const { familyId } = useFamily();
  const s = useCollection<Schedule & Audit>(familyId ? paths.schedules(familyId) : null);
  const t = useCollection<Task & Audit>(familyId ? paths.tasks(familyId) : null);
  const sh = useCollection<ShoppingItem & Audit>(familyId ? paths.shopping(familyId) : null);
  const h = useCollection<Handover & Audit>(familyId ? paths.handovers(familyId) : null);
  const handovers = useMemo<PHandover[]>(
    () => h.data.map((x) => ({ ...x, createdAtMs: x.createdAt?.toMillis?.() ?? Date.now() })),
    [h.data],
  );
  return {
    schedules: s.data as PSchedule[],
    tasks: t.data as PTask[],
    shopping: sh.data as PShopping[],
    handovers,
    loading: s.loading || t.loading || sh.loading || h.loading,
    error: s.error || t.error || sh.error || h.error,
  };
}

/** 自分の ack を申し送りごとに購読。ready=全件の初回読込済み */
export function useMyAcks(familyId: string | null, uid: string | null, ids: string[]) {
  const [acks, setAcks] = useState<Record<string, Ack | null>>({});
  const key = ids.slice().sort().join(',');
  useEffect(() => {
    if (!familyId || !uid) return;
    const unsubs = key
      .split(',')
      .filter(Boolean)
      .map((id) =>
        onSnapshot(
          doc(paths.acks(familyId, id), uid),
          (snap) => setAcks((m) => ({ ...m, [id]: snap.exists() ? (snap.data() as Ack) : null })),
          () => setAcks((m) => ({ ...m, [id]: null })),
        ),
      );
    return () => unsubs.forEach((u) => u());
  }, [familyId, uid, key]);
  const ready = ids.every((id) => id in acks);
  return { acks, ready };
}

/** 確認（受領）。解決とは別。オフラインでもキューされる */
export function acknowledgeHandover(familyId: string, hid: string, uid: string, revision: number): Promise<void> {
  return setDoc(doc(paths.acks(familyId, hid), uid), {
    uid,
    acknowledgedAt: serverTimestamp(),
    handoverRevision: revision,
  });
}
