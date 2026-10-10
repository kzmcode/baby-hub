import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../components';
import { showRecorded } from './RecordedBar';
import { useFamily } from '../../context';
import { api, apiErrorMessage } from '../../lib/api';
import { createEvent, type CreateEventInput } from '../../lib/db';
import type { EventType } from '../../types/models';

/**
 * 保存後に「詳細を追加」「取り消す」付きトーストを出す記録ヘルパ。
 * 取り消す＝setEventStatus(void)。未同期（オフライン）の書込みはサーバーに存在しないため、オンライン時のみ可能。
 */
export function useRecorder() {
  const { familyId, childId, memberName } = useFamily();
  const toast = useToast();
  const navigate = useNavigate();

  const undo = useCallback(
    async (id: string, promise: Promise<void>) => {
      if (!familyId || !childId) return;
      if (!navigator.onLine) {
        toast.show('オフラインのため取り消せません。通信が回復したら記録の詳細から無効化してください。', { tone: 'error', duration: 8000 });
        return;
      }
      try {
        // サーバー到達を少し待つ（未到達なら not-found になるため）
        await Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
        await api.setEventStatus({ familyId, childId, eventId: id, expectedRevision: 1, status: 'void' });
        toast.show('取り消しました（記録の詳細から戻せます）');
      } catch (e) {
        const msg = e instanceof Error && e.message === 'timeout' ? 'まだ共有できていないため取り消せません。同期後に詳細から無効化してください。' : apiErrorMessage(e);
        toast.show(msg, { tone: 'error', duration: 8000 });
      }
    },
    [familyId, childId, toast],
  );

  const record = useCallback(
    <T extends EventType>(input: CreateEventInput<T>, label: string): string | null => {
      if (!familyId || !childId) return null;
      try {
        const { id, promise } = createEvent(familyId, childId, input);
        const who = input.caregiverUid === undefined ? '' : `（お世話：${memberName(input.caregiverUid)}）`;
        promise.catch(() => toast.show('共有に失敗しました。通信を確認してください（端末には保存されています）', { tone: 'error' }));
        showRecorded({ id, message: `${label}を記録しました${who}`, undo: () => void undo(id, promise) });
        return id;
      } catch (e) {
        toast.show(e instanceof Error ? e.message : '保存できませんでした', { tone: 'error' });
        return null;
      }
    },
    [familyId, childId, memberName, toast, undo],
  );

  const goDetail = useCallback((id: string) => navigate(`/records/${id}`), [navigate]);
  return { record, undo, goDetail };
}
