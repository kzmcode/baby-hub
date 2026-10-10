import { useEffect, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { CategoryIcon } from '../../components';

interface Recorded { id: string; message: string; undo: () => void; key: number }
let current: Recorded | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showRecorded(r: Omit<Recorded, 'key'>) {
  current = { ...r, key: ++seq };
  emit();
}
function clear(key: number) {
  if (current?.key === key) { current = null; emit(); }
}

/** 保存直後の確認バー（詳細を追加／取り消す）。ホームと記録画面に置く */
export function RecordedBar() {
  const cur = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
  const navigate = useNavigate();
  useEffect(() => {
    if (!cur) return;
    const t = setTimeout(() => clear(cur.key), 10000);
    return () => clearTimeout(t);
  }, [cur]);
  if (!cur) return null;
  return (
    <div className="rec-bar" role="status" aria-live="polite">
      <div className="rec-bar__msg"><CategoryIcon name="check" size={18} /> {cur.message}</div>
      <div className="rec-bar__actions">
        <button type="button" onClick={() => { const id = cur.id; clear(cur.key); navigate(`/records/${id}`); }}>詳細を追加</button>
        <button type="button" onClick={() => { const u = cur.undo; clear(cur.key); u(); }}>取り消す</button>
        <button type="button" className="rec-bar__x" onClick={() => clear(cur.key)} aria-label="閉じる">閉じる</button>
      </div>
      <div className="rec-bar__note small">取り消しはオンライン時のみ。圏外では詳細から後で無効化できます。</div>
    </div>
  );
}
