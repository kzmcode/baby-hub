import type { Audit, Handover, Schedule, ShoppingItem, Task } from '../../types/models';
import type { WithMeta } from '../../lib/db';

export type PSchedule = WithMeta<Schedule & Audit>;
export type PTask = WithMeta<Task & Audit>;
export type PShopping = WithMeta<ShoppingItem & Audit>;
export type PHandover = WithMeta<Handover & Audit> & { createdAtMs: number };

export type PlanTab = 'schedules' | 'tasks' | 'shopping' | 'handovers';

/** null を除去（作成時: 未入力キーは省略する） */
export function omitNull<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}
