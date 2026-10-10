// set / update / create / delete を Firestore REST の Write（commit 用）へ変換する
import { ApiError } from '../errors';
import { Fields, Value, isPlainObject, toValue } from './codec';
import { FieldValueSentinel } from './field-value';

export interface FieldTransform {
  fieldPath: string;
  setToServerValue?: 'REQUEST_TIME';
  increment?: Value;
  appendMissingElements?: { values: Value[] };
  removeAllFromArray?: { values: Value[] };
}
export interface Write {
  update?: { name: string; fields: Fields };
  updateMask?: { fieldPaths: string[] };
  updateTransforms?: FieldTransform[];
  delete?: string;
  currentDocument?: { exists: boolean };
}

const SIMPLE = /^[A-Za-z_][A-Za-z_0-9]*$/;
export function quoteSegment(s: string): string {
  return SIMPLE.test(s) ? s : '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}
export const fieldPathOf = (segs: string[]): string => segs.map(quoteSegment).join('.');

function invalid(msg: string): never {
  throw new ApiError('internal', msg);
}

function sentinelTransform(path: string, s: FieldValueSentinel, root: string): FieldTransform {
  switch (s.kind) {
    case 'serverTimestamp': return { fieldPath: path, setToServerValue: 'REQUEST_TIME' };
    case 'increment': return { fieldPath: path, increment: toValue(s.operand as number, root) };
    case 'arrayUnion': return { fieldPath: path, appendMissingElements: { values: (s.operand as unknown[]).map((x) => toValue(x, root)) } };
    case 'arrayRemove': return { fieldPath: path, removeAllFromArray: { values: (s.operand as unknown[]).map((x) => toValue(x, root)) } };
    default: return invalid('FieldValue.delete() is not a transform');
  }
}

interface Extracted {
  fields: Fields;
  transforms: FieldTransform[];
  deletes: string[]; // FieldValue.delete() のフィールドパス
  leaves: string[]; // merge 用：値を書くリーフのパス（空マップ含む）
}

/** マップを走査し、センチネルを取り除いた fields と transforms/deletes/leaves を得る */
function extract(obj: Record<string, unknown>, prefix: string[], root: string, out: Extracted): Fields {
  const fields: Fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const path = [...prefix, k];
    if (v instanceof FieldValueSentinel) {
      if (v.kind === 'delete') out.deletes.push(fieldPathOf(path));
      else out.transforms.push(sentinelTransform(fieldPathOf(path), v, root));
      continue;
    }
    if (isPlainObject(v)) {
      const before = out.transforms.length + out.deletes.length;
      const inner = extract(v, path, root, out);
      const hadSentinel = out.transforms.length + out.deletes.length > before;
      if (Object.keys(inner).length === 0 && hadSentinel && Object.keys(v).length > 0) continue; // センチネルのみのマップ
      fields[k] = { mapValue: { fields: inner } };
      if (Object.keys(inner).length === 0) out.leaves.push(fieldPathOf(path)); // 空マップ
      continue;
    }
    fields[k] = toValue(v, root);
    out.leaves.push(fieldPathOf(path));
  }
  return fields;
}

const newExtracted = (): Extracted => ({ fields: {}, transforms: [], deletes: [], leaves: [] });

export function buildSet(name: string, dataIn: object, merge: boolean, root: string): Write {
  const data = dataIn as Record<string, unknown>;
  const ex = newExtracted();
  const fields = extract(data, [], root, ex);
  if (!merge && ex.deletes.length) invalid('FieldValue.delete() is only valid with merge or update');
  const w: Write = { update: { name, fields } };
  if (merge) w.updateMask = { fieldPaths: [...ex.leaves, ...ex.deletes] };
  if (ex.transforms.length) w.updateTransforms = ex.transforms;
  return w;
}

export function buildCreate(name: string, dataIn: object, root: string): Write {
  const w = buildSet(name, dataIn, false, root);
  w.currentDocument = { exists: false };
  return w;
}

/** update(): キーはドット区切りのフィールドパス。値のマップはそのフィールドを丸ごと置換する（admin と同じ） */
export function buildUpdate(name: string, dataIn: object, root: string): Write {
  const data = dataIn as Record<string, unknown>;
  const fields: Fields = {};
  const mask: string[] = [];
  const transforms: FieldTransform[] = [];
  for (const [key, v] of Object.entries(data)) {
    if (v === undefined) continue;
    const segs = key.split('.');
    if (segs.some((s) => s === '')) invalid('Invalid field path');
    const path = fieldPathOf(segs);
    if (v instanceof FieldValueSentinel) {
      if (v.kind === 'delete') mask.push(path);
      else transforms.push(sentinelTransform(path, v, root));
      continue;
    }
    let value: Value;
    if (isPlainObject(v)) {
      const ex = newExtracted();
      const inner = extract(v, segs, root, ex);
      if (ex.deletes.length) invalid('FieldValue.delete() is only valid at the top level of update()');
      transforms.push(...ex.transforms);
      value = { mapValue: { fields: inner } };
    } else {
      value = toValue(v, root);
    }
    mask.push(path);
    // ネストしたパスを fields に配置
    let cur = fields;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i]!;
      let next = cur[s];
      if (!next) next = cur[s] = { mapValue: { fields: {} } };
      cur = next.mapValue.fields as Fields;
    }
    cur[segs[segs.length - 1]!] = value;
  }
  const w: Write = { update: { name, fields }, updateMask: { fieldPaths: mask }, currentDocument: { exists: true } };
  if (transforms.length) w.updateTransforms = transforms;
  return w;
}
