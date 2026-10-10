// CSV 変換（純粋関数）。UTF-8 BOM 付きで Excel でも文字化けしにくくする
import type { ExportData } from '../../../lib/api';

export const BOM = '﻿';

/** ネストしたオブジェクトを `a.b.c` 形式の1階層に展開。配列は JSON 文字列 */
export function flatten(obj: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj === null || obj === undefined) {
    if (prefix) out[prefix] = '';
    return out;
  }
  if (Array.isArray(obj)) {
    out[prefix] = JSON.stringify(obj);
    return out;
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0 && prefix) out[prefix] = '';
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix] = obj;
  return out;
}

/** 1セルのエスケープ。表計算ソフトの数式として解釈されうる先頭文字（= + - @ タブ CR）は ' を前置 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 行配列を CSV 文字列へ（BOM なし）。columns 未指定なら全行のキーの和集合（初出順） */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const flat = rows.map((r) => flatten(r));
  const cols = columns ?? [...new Set(flat.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of flat) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export interface CsvFile { key: string; label: string; filename: string; rows: number; content: string }

function withChildId(items: unknown[], childId: unknown): Record<string, unknown>[] {
  return (items ?? []).map((x) => ({ childId, ...(x as Record<string, unknown>) }));
}

/** エクスポートデータを種類ごとの CSV に分割（BOM 付き）。空のコレクションは除く */
export function buildCsvFiles(data: ExportData, date = data.exportedAt.slice(0, 10)): CsvFile[] {
  const groups: { key: string; label: string; rows: Record<string, unknown>[] }[] = [];
  const kids = data.children ?? [];
  const per = (pick: (c: ExportData['children'][number]) => unknown[]) =>
    kids.flatMap((c) => withChildId(pick(c), (c.child as { id?: unknown } | null)?.id ?? ''));
  groups.push({ key: 'events', label: '日常の記録', rows: per((c) => c.events) });
  groups.push({ key: 'children', label: '子ども', rows: kids.map((c) => c.child as Record<string, unknown>) });
  groups.push({
    key: 'healthProfiles', label: '健康プロフィール',
    rows: kids.filter((c) => c.healthProfile).map((c) => ({ childId: (c.child as { id?: unknown })?.id ?? '', ...(c.healthProfile as Record<string, unknown>) })),
  });
  groups.push({ key: 'medications', label: '薬', rows: per((c) => c.medications) });
  groups.push({ key: 'doseOccurrences', label: '投薬の予定・実績', rows: per((c) => c.doseOccurrences) });
  groups.push({ key: 'medicalVisits', label: '受診メモ', rows: per((c) => c.medicalVisits) });
  groups.push({ key: 'vaccinations', label: '予防接種・健診', rows: per((c) => c.vaccinations) });
  groups.push({ key: 'schedules', label: '予定', rows: (data.schedules ?? []) as Record<string, unknown>[] });
  groups.push({ key: 'tasks', label: 'ToDo', rows: (data.tasks ?? []) as Record<string, unknown>[] });
  groups.push({ key: 'shopping', label: '買い物', rows: (data.shopping ?? []) as Record<string, unknown>[] });
  groups.push({ key: 'handovers', label: '申し送り', rows: (data.handovers ?? []) as Record<string, unknown>[] });
  groups.push({ key: 'contacts', label: '連絡先・参考先', rows: (data.contacts ?? []) as Record<string, unknown>[] });
  groups.push({ key: 'members', label: 'メンバー', rows: (data.members ?? []) as Record<string, unknown>[] });
  return groups
    .filter((g) => g.rows.length > 0)
    .map((g) => ({ key: g.key, label: g.label, filename: `baby-hub-${g.key}-${date}.csv`, rows: g.rows.length, content: BOM + toCsv(g.rows) }));
}
