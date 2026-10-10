import { handlers as account } from '../account';
import { handlers as documents } from '../documents';
import { handlers as family } from '../family';
import { handlers as medication } from '../medication';
import { handlers as notify } from '../notify';
import type { Handler } from './context';
import { dispatch } from './dispatch';
import type { Platform } from './platform/types';

export const allHandlers: Record<string, Handler> = { ...family, ...documents, ...medication, ...account, ...notify };

/** 戻り値は JSON 文字列 {ok:true,result} | {ok:false,error:{code,message,details}} */
export function handleRequest(platform: Platform, rawBody: string): string {
  return dispatch(platform, rawBody, allHandlers);
}
