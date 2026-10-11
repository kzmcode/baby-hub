export { getDeviceId, cleanupDeviceRegistration } from '../../lib/device';

const INVITE_KEY = 'ch.setupInvite';

// 初期設定の作成〜招待発行の途中は、家族の確定を検知した SetupGuard がホームへ飛ばさないようにする
// （再読み込みで消えるよう、保存はメモリのみ）
let setupInFlight = false;
export function setSetupInFlight(v: boolean): void { setupInFlight = v; }
export function isSetupInFlight(): boolean { return setupInFlight; }

export interface StoredInvite { inviteId: string; token: string; expiresAt: string }
export function saveInvite(i: StoredInvite | null): void {
  try { if (i) sessionStorage.setItem(INVITE_KEY, JSON.stringify(i)); else sessionStorage.removeItem(INVITE_KEY); } catch { /* ignore */ }
}
export function loadInvite(): StoredInvite | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(INVITE_KEY) ?? 'null') as StoredInvite | null;
    if (v && new Date(v.expiresAt).getTime() > Date.now()) return v;
  } catch { /* ignore */ }
  return null;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}
export async function shareText(text: string, url?: string): Promise<void> {
  try { await navigator.share({ title: 'Baby hub への招待', text, url }); } catch { /* キャンセル */ }
}

export function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function formatDateTimeJa(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export { safeHttpsUrl, telHref } from '../../lib/safeUrl';
