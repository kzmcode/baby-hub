import type { Ev } from './types';
import type { CategoryName } from '../../../components';

export const TYPE_LABEL: Record<string, string> = {
  feeding: '授乳・ミルク', pumping: '搾乳', diaper: 'おむつ', sleep_start: '寝た', sleep_end: '起きた',
  bath: '沐浴', vomit: '吐いた', temperature: '体温', symptom: '症状', growth: '身長・体重',
  medication_taken: '服薬', meal: '食事', milestone: 'できたこと', memo: 'その他',
};

export function categoryOf(type: string): CategoryName {
  switch (type) {
    case 'feeding': case 'pumping': return 'feeding';
    case 'diaper': return 'diaper';
    case 'sleep_start': case 'sleep_end': return 'sleep';
    case 'bath': return 'bath';
    case 'vomit': return 'vomit';
    case 'temperature': case 'symptom': return 'temperature';
    case 'growth': return 'growth';
    case 'medication_taken': return 'medication';
    default: return 'other';
  }
}

const METHOD: Record<string, string> = { breast: '母乳', formula: 'ミルク', expressed_breast_milk: '搾母乳' };
const YN: Record<string, string> = { yes: 'あり', no: 'なし', unknown: '未確認' };
const AMOUNT: Record<string, string> = { small: '少量', medium: '中くらい', large: '多め', unknown: '不明' };

export function feedingLabel(e: Ev): string {
  return METHOD[e.payload.method as string] ?? '授乳';
}

/** 量の表示。未入力は「量未入力」 */
export function amountText(e: Ev): string | null {
  if (e.type === 'feeding' && e.payload.method !== 'breast') {
    return typeof e.payload.consumedMl === 'number' ? `${e.payload.consumedMl}mL` : '量未入力';
  }
  if (e.type === 'pumping') return typeof e.payload.expressedMl === 'number' ? `${e.payload.expressedMl}mL` : '量未入力';
  return null;
}

/** 一覧用の1行タイトルと補足 */
export function describeEvent(e: Ev): { title: string; detail?: string } {
  const p = e.payload;
  switch (e.type) {
    case 'feeding': {
      const a = amountText(e);
      const sec = [p.leftSeconds ? `左${Math.round(p.leftSeconds / 60)}分` : '', p.rightSeconds ? `右${Math.round(p.rightSeconds / 60)}分` : ''].filter(Boolean).join(' ');
      return { title: feedingLabel(e), detail: [a, sec].filter(Boolean).join(' ') || undefined };
    }
    case 'pumping': return { title: '搾乳', detail: amountText(e) ?? undefined };
    case 'diaper':
      return { title: 'おむつ', detail: `尿:${YN[p.urine] ?? '未確認'} 便:${YN[p.stool] ?? '未確認'}${p.stoolNote ? `（${p.stoolNote}）` : ''}` };
    case 'sleep_start': return { title: '寝た' };
    case 'sleep_end': return { title: '起きた' };
    case 'bath': return { title: '沐浴', detail: p.bathingMode === 'sponge' ? 'スポンジ' : p.bathingMode === 'tub' ? '浴槽' : undefined };
    case 'vomit':
      return { title: '吐いた', detail: [p.amountCategory ? `量の印象:${AMOUNT[p.amountCategory]}` : '', p.appearanceText ?? ''].filter(Boolean).join(' ') || undefined };
    case 'memo': return { title: 'その他の変化', detail: [...((p.tags as string[] | undefined) ?? []), p.text ?? ''].filter(Boolean).join(' / ') || undefined };
    case 'temperature': return { title: '体温', detail: p.celsius != null ? `${p.celsius}℃` : undefined };
    case 'symptom': return { title: '症状', detail: ((p.symptomTags as string[] | undefined) ?? []).join(' / ') || undefined };
    case 'growth': return { title: '身長・体重', detail: [p.heightCm != null ? `${p.heightCm}cm` : '', p.weightGrams != null ? `${p.weightGrams}g` : ''].filter(Boolean).join(' ') || undefined };
    default: return { title: TYPE_LABEL[e.type] ?? e.type };
  }
}

/** 「◯◯が実施（△△が入力）」 */
export function whoText(e: Ev, name: (uid?: string | null) => string): string {
  if (!e.caregiverUid) return `実施者未確認（${name(e.createdBy)}が入力）`;
  if (e.caregiverUid !== e.createdBy) return `${name(e.caregiverUid)}が実施（${name(e.createdBy)}が入力）`;
  return `${name(e.caregiverUid)}が実施`;
}

export const MARKER_LABEL: Record<string, string> = {
  breast: '母乳', formula: 'ミルク', expressed: '搾母乳', pumping: '搾乳',
  urine: 'おむつ(尿)', stool: 'おむつ(便)', both: 'おむつ(尿+便)', diaper_only: 'おむつ(交換のみ)', diaper_unknown: 'おむつ(未確認)',
  vomit: '吐いた', bath: '沐浴', other: 'その他',
};
