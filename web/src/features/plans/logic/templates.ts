// 出生後の手続き候補テンプレート（要件 5.2）。
// 自治体ごとの確定期限は持たない。期限は未確認の「目安」として扱い、deadlineVerified=false、sourceUrl 空。
export interface ProcedureTemplate {
  key: string;
  title: string;
  /** 全国共通の説明（確認用の目安。確定期限ではない） */
  basis: string;
  step: string;
  /** 出生日からの目安日数（null は期限の目安なし） */
  offsetDays: number | null;
}

export const PROCEDURE_TEMPLATES: ProcedureTemplate[] = [
  { key: 'birth-notification', title: '出生届を提出する', basis: '国内出生は出生の日から14日以内が目安。国外出生などは条件が異なります。提出先・期限は自治体で要確認', step: '提出先・必要物の確認', offsetDays: 14 },
  { key: 'child-allowance', title: '児童手当を申請する', basis: '出生の日の翌日から15日以内の申請案内が目安。公務員は勤務先。出生届とは別の手続き。期限は自治体で要確認', step: '申請先の確認', offsetDays: 16 },
  { key: 'child-medical-subsidy', title: '子ども医療費助成（医療証）を申請する', basis: '制度・申請方法・期限は自治体ごとに異なります。自治体の公式案内を要確認', step: '自治体の公式案内の確認', offsetDays: null },
  { key: 'health-insurance', title: '健康保険に加入する（子の保険証）', basis: '加入先・勤務先・扶養条件により異なります。期限は加入先に要確認', step: '加入先への連絡・必要書類の確認', offsetDays: null },
  { key: 'birth-lump-sum', title: '出産育児一時金を確認・申請する', basis: '加入している健康保険や分娩施設の案内に従います。期限は加入先に要確認', step: '加入先・分娩施設への確認', offsetDays: null },
  { key: 'newborn-visit', title: '出生連絡・新生児訪問の案内を確認する', basis: '居住地の案内に従います。自治体で要確認', step: '自治体からの案内の確認', offsetDays: null },
];

export interface TemplateTaskData {
  title: string;
  category: 'procedure';
  status: 'todo';
  assigneeUid: null;
  dueDate: string | null;
  deadlineBasis: string;
  deadlineVerified: false;
  step: string;
  relatedRefs: [];
}

/** 出生日(yyyy-MM-dd)があれば目安日を入れる。未確認の目安であり確定期限ではない */
export function buildTemplateTask(t: ProcedureTemplate, birthDate: string | null | undefined, addDays: (d: string, n: number) => string): TemplateTaskData {
  return {
    title: t.title,
    category: 'procedure',
    status: 'todo',
    assigneeUid: null,
    dueDate: birthDate && t.offsetDays != null ? addDays(birthDate, t.offsetDays) : null,
    deadlineBasis: t.basis,
    deadlineVerified: false,
    step: t.step,
    relatedRefs: [],
  };
}

/** 既存タスクと同名のテンプレートを除いた追加候補 */
export function missingTemplates(existingTitles: string[]): ProcedureTemplate[] {
  const set = new Set(existingTitles);
  return PROCEDURE_TEMPLATES.filter((t) => !set.has(t.title));
}
