import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiErrorMessage } from '../../lib/api';
import { useAuth } from '../../context';
import { Button, Card, Field, TextInput } from '../../components';
import { INVITE_STORAGE_KEY, extractToken, parseHashToken } from './logic/invite';
import { inviteErrorMessage } from './logic/errors';
import { formatDateTimeJa } from './util';
import './account.css';

interface Preview { familyName: string; inviterName: string; role: string; expiresAt: string }

function readStored(): string | null {
  try { return sessionStorage.getItem(INVITE_STORAGE_KEY); } catch { return null; }
}
function store(t: string | null): void {
  try { if (t) sessionStorage.setItem(INVITE_STORAGE_KEY, t); else sessionStorage.removeItem(INVITE_STORAGE_KEY); } catch { /* ignore */ }
}

export function JoinPage() {
  const { user } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const initialized = useRef(false);
  const [attempt, setAttempt] = useState(0);

  // トークンを URL から読み取り、直ちに履歴から除去（ログイン往復用に sessionStorage へ一時保持）
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const fromHash = parseHashToken(window.location.hash);
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }
    const t = fromHash ?? readStored();
    if (fromHash) store(fromHash);
    setToken(t);
  }, []);

  useEffect(() => {
    if (!token) { setPreview(null); return; }
    let cancelled = false;
    setLoading(true); setError('');
    api.previewInvite({ token })
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e) => { if (!cancelled) { setPreview(null); setError(inviteErrorMessage(e, apiErrorMessage(e))); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, attempt]);

  function applyManual() {
    const t = extractToken(manual);
    if (!t) { setError('招待コードの形式が正しくありません。リンクまたはコード全体を貼り付けてください。'); return; }
    // 失敗時に打ち直さなくて済むよう入力は残す（成功すると入力欄自体が消える）
    store(t); setError(''); setToken(t); setAttempt((n) => n + 1);
  }

  async function accept() {
    if (!token) return;
    setBusy(true); setError('');
    try {
      await api.acceptInvite({ token, displayName: displayName.trim() });
      store(null);
      window.location.replace('/'); // 状態を完全に読み込み直す
    } catch (e) {
      setError(inviteErrorMessage(e, apiErrorMessage(e)));
      setBusy(false);
    }
  }

  return (
    <main className="page stack acc-narrow">
      <h1>家族に参加する</h1>

      {loading && <p className="muted" role="status">招待を確認しています…</p>}

      {preview && (
        <Card className="stack">
          <p><strong>{preview.inviterName}</strong> さんから「<strong>{preview.familyName}</strong>」への招待です。</p>
          <ul className="small">
            <li>権限: {preview.role === 'owner' ? '管理者' : '家族メンバー（編集者）'}</li>
            <li>有効期限: {formatDateTimeJa(preview.expiresAt)}</li>
          </ul>
          <Card tone="warning" className="small">
            参加すると、この家族の子どもの記録・予定・申し送り・健康情報（体温、薬、受診メモなど）が閲覧・編集できるようになり、あなたの表示名が家族に表示されます。
          </Card>
          <Field label="あなたの表示名">
            {(p) => <TextInput {...p} maxLength={50} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
          </Field>
          <Button variant="primary" block loading={busy} disabled={!displayName.trim()} onClick={accept}>この家族に参加する</Button>
        </Card>
      )}

      {error && (
        <Card tone="danger" className="stack">
          <p role="alert">{error}</p>
          {token && !preview && <Button onClick={() => setAttempt((n) => n + 1)}>もう一度確認する</Button>}
        </Card>
      )}

      {!preview && !loading && (
        <Card className="stack">
          <p className="small muted">招待リンクを開くと自動で表示されます。リンクが開けない場合は、招待コード（またはリンク全体）を貼り付けてください。</p>
          <Field label="招待コード / リンク">
            {(p) => <TextInput {...p} autoComplete="off" value={manual} onChange={(e) => setManual(e.target.value)} />}
          </Field>
          <Button onClick={applyManual} disabled={!manual.trim()}>確認する</Button>
        </Card>
      )}

      <p className="small"><Link to="/">ホームに戻る</Link></p>
    </main>
  );
}
