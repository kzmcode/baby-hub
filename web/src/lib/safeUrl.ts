// 外部入力 URL / 電話番号の表示前検証（Rules・GAS 側に加えた多層防御）

/** https の URL のみ許可（それ以外は null）。資格情報つき URL も拒否 */
export function safeHttpsUrl(v: string | undefined | null): string | null {
  if (!v) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 電話番号を tel: に使える文字（数字・+・-）だけにして href 化。3桁未満は null */
export function telHref(v: string | undefined | null): string | null {
  const d = (v ?? '').replace(/[^\d+-]/g, '');
  return d.replace(/\D/g, '').length >= 3 ? `tel:${d}` : null;
}
