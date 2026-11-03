import type { SqlBankListItem, SqlBankQuestion, SqlCheckResult, SqlQuestionInput, SqlStarterImportResult } from '@hireflow/contracts';
import { call, type Options } from './publisher-api';

/**
 * The company's SQL question bank (HR). Session cookie + CSRF header; the company always comes from the session on the
 * server. Every question HR saves is first RUN on the server (schema, datasets, reference query), so a save can fail
 * with what does not work (422 SQL_QUESTION_NOT_RUNNABLE); `checkSqlQuestion` shows everything without saving.
 */
const base = '/sql-hr/questions';
const one = (id: string) => `${base}/${encodeURIComponent(id)}`;

/** The API's own types (contracts); only the shape is checked here. */
const object = <T>(v: unknown): T => {
  if (!v || typeof v !== 'object') throw new Error('Unexpected response');
  return v as T;
};
const list = <T>(v: unknown): T[] => {
  if (!Array.isArray(v)) throw new Error('Unexpected response');
  return v as T[];
};

export const listSqlQuestions = (opts: Options = {}) => call('GET', base, undefined, list<SqlBankListItem>, opts);
export const getSqlQuestion = (id: string, opts: Options = {}) => call('GET', one(id), undefined, object<SqlBankQuestion>, opts);
export const checkSqlQuestion = (input: SqlQuestionInput, opts: Options = {}) => call('POST', `${base}/check`, input, object<SqlCheckResult>, opts);
export const createSqlQuestion = (input: SqlQuestionInput, opts: Options = {}) => call('POST', base, input, object<SqlBankQuestion>, opts);
export const updateSqlQuestion = (id: string, input: SqlQuestionInput, opts: Options = {}) => call('PUT', one(id), input, object<SqlBankQuestion>, opts);
export const setSqlQuestionActive = (id: string, active: boolean, opts: Options = {}) =>
  call('PATCH', `${one(id)}/active`, { active }, object<SqlBankQuestion>, opts);
export const deleteSqlQuestion = (id: string, opts: Options = {}) => call('DELETE', one(id), undefined, () => undefined, opts);
let active: Promise<SqlBankListItem[]> | null = null;
/** The active bank questions, for the rounds editor's picker (fetched once per page; a failure is retried next time). */
export function activeSqlQuestions(): Promise<SqlBankListItem[]> {
  active ??= listSqlQuestions()
    .then((l) => l.filter((q) => q.active))
    .catch((err: unknown) => {
      active = null;
      throw err;
    });
  return active;
}

/** Adds the 15 starter questions the company does not have yet (safe to press twice). */
export const addStarterSqlQuestions = (opts: Options = {}) => call('POST', `${base}/starter`, undefined, object<SqlStarterImportResult>, opts);
