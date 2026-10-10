export type FieldValueKind = 'serverTimestamp' | 'delete' | 'increment' | 'arrayUnion' | 'arrayRemove';

export class FieldValueSentinel {
  constructor(readonly kind: FieldValueKind, readonly operand?: unknown) {}
}

export const FieldValue = {
  serverTimestamp: (): FieldValueSentinel => new FieldValueSentinel('serverTimestamp'),
  delete: (): FieldValueSentinel => new FieldValueSentinel('delete'),
  increment: (n: number): FieldValueSentinel => new FieldValueSentinel('increment', n),
  arrayUnion: (...v: unknown[]): FieldValueSentinel => new FieldValueSentinel('arrayUnion', v),
  arrayRemove: (...v: unknown[]): FieldValueSentinel => new FieldValueSentinel('arrayRemove', v),
};
