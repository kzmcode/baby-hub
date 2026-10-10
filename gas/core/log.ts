import { getPlatform } from './context';

type Fields = Record<string, string | number | boolean>;

/** ログには ID・種別・件数のみを出す（子どもの名前・自由文・薬名・トークンは出さない） */
export const logInfo = (msg: string, fields?: Fields): void => getPlatform().log('info', msg, fields);
export const logWarn = (msg: string, fields?: Fields): void => getPlatform().log('warn', msg, fields);
export const logError = (msg: string, fields?: Fields): void => getPlatform().log('error', msg, fields);
