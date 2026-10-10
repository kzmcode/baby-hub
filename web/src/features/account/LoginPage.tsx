import { useEffect, useState, type FormEvent } from 'react';
import {
  GoogleAuthProvider, createUserWithEmailAndPassword, getRedirectResult, sendEmailVerification,
  sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup, signInWithRedirect,
} from 'firebase/auth';
import { auth } from '../../lib/firebase';
import { Button, Card, Field, Logo, SegmentedControl, TextInput } from '../../components';
import { authErrorMessage, shouldFallbackToRedirect } from './logic/errors';
import './account.css';

type Mode = 'login' | 'register';

/** S01 ログイン。ログイン後の遷移は routes.tsx の RedirectIfAuthed（location.state.from）が行う */
export function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  useEffect(() => {
    getRedirectResult(auth).catch((e) => setError(authErrorMessage(e)));
  }, []);

  async function google() {
    setError(''); setInfo(''); setBusy(true);
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      if (shouldFallbackToRedirect(e)) {
        try { await signInWithRedirect(auth, provider); return; } catch (e2) { setError(authErrorMessage(e2)); }
      } else setError(authErrorMessage(e));
    }
    setBusy(false);
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setError(''); setInfo(''); setBusy(true);
    try {
      if (mode === 'register') {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        try { await sendEmailVerification(cred.user); } catch { /* 後で設定画面から再送できる */ }
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (e) {
      setError(authErrorMessage(e));
      setBusy(false);
    }
  }

  async function reset() {
    setError(''); setInfo('');
    if (!email.trim()) { setError('パスワード再設定のため、メールアドレスを入力してください。'); return; }
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setInfo('登録されているメールアドレスであれば、再設定用のメールを送信しました。届かない場合は迷惑メールも確認してください。');
    } catch (e) { setError(authErrorMessage(e)); }
  }

  return (
    <main className="page stack acc-narrow">
      <div className="row"><Logo size={56} /><h1 style={{ margin: 0 }}>Baby hub</h1></div>
      <p className="muted">夫婦で育児の記録・予定・健康情報を共有するアプリです。</p>

      <Card className="stack">
        <Button variant="primary" block loading={busy} onClick={google}>Google でログイン</Button>
      </Card>

      <Card>
        <form className="stack" onSubmit={submit}>
          <SegmentedControl<Mode>
            ariaLabel="メールでの認証方法"
            options={[{ value: 'login', label: 'ログイン' }, { value: 'register', label: '新規登録' }]}
            value={mode} onChange={setMode}
          />
          <Field label="メールアドレス">
            {(p) => <TextInput {...p} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label="パスワード" hint={mode === 'register' ? '6文字以上' : undefined}>
            {(p) => (
              <TextInput {...p} type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
            )}
          </Field>
          {error && <p className="acc-err" role="alert">{error}</p>}
          {info && <p role="status">{info}</p>}
          <Button type="submit" variant="primary" block loading={busy}>{mode === 'register' ? '登録して確認メールを送る' : 'ログイン'}</Button>
          {mode === 'login' && <Button variant="ghost" onClick={reset}>パスワードを忘れた場合</Button>}
        </form>
      </Card>

      <Card tone="warning" className="stack">
        <strong>ログイン方法にご注意ください</strong>
        <p className="small">以前と別の方法（Google とメールなど）で新しくアカウントを作ると、データが空に見えます。以前使った方法でログインしてください。ログイン方法を変えただけで、同じ人のアカウントとして自動で統合されることはありません。</p>
        <p className="small">招待リンクから来た方は、ログイン後に自動で参加画面に戻ります。</p>
      </Card>
    </main>
  );
}
