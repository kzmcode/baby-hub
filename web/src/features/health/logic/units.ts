// 単位変換・入力検証（純粋関数）

/** kg の文字列/数値 → g（整数）。不正は null */
export function kgToGrams(kg: string | number): number | null {
  const n = typeof kg === 'number' ? kg : Number(String(kg).trim());
  if (String(kg).trim() === '' || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000);
}

/** g → kg 表示用（小数第3位まで、末尾0は落とす） */
export function gramsToKgText(g: number): string {
  return String(Number((g / 1000).toFixed(3)));
}

/** 数値文字列のパース。空・不正は null */
export function parseNum(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export const TEMP_MIN = 30;
export const TEMP_MAX = 45;
export const HEIGHT_MIN = 20;
export const HEIGHT_MAX = 150;
export const WEIGHT_MIN_G = 300;
export const WEIGHT_MAX_G = 50000;

export function validateCelsius(c: number | null): string | null {
  if (c === null) return '体温を数字で入力してください';
  if (c < TEMP_MIN || c > TEMP_MAX) return `${TEMP_MIN}〜${TEMP_MAX}℃の範囲で入力してください`;
  return null;
}

/** 身長・体重（g）の検証。どちらか必須 */
export function validateGrowth(heightCm: number | null, weightG: number | null): string | null {
  if (heightCm === null && weightG === null) return '身長か体重のどちらかを入力してください';
  if (heightCm !== null && (heightCm < HEIGHT_MIN || heightCm > HEIGHT_MAX)) return `身長は${HEIGHT_MIN}〜${HEIGHT_MAX}cmの範囲で入力してください`;
  if (weightG !== null && (weightG < WEIGHT_MIN_G || weightG > WEIGHT_MAX_G)) return '体重は0.3〜50kgの範囲で入力してください';
  return null;
}
