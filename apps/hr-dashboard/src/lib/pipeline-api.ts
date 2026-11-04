import type { JobPipelineStatuses, PiBoard, PiCallStatus, PipelineSettingsInput, PipelineSettingsView, RoundRubricView, RubricParameter } from '@hireflow/contracts';
import { call, type Options } from './publisher-api';

/**
 * Hiring pipeline rules and views (HR only): Stage 2 overall criterion, rejection emails on / off, the GD rubric,
 * every student's pipeline status and the personal-interview (HR call) section.
 */
const job = (jobId: string) => `/pipeline/jobs/${encodeURIComponent(jobId)}`;
const as = <T,>(v: unknown) => v as T;

export const getPipelineSettings = (jobId: string, opts: Options = {}) => call('GET', `${job(jobId)}/settings`, undefined, as<PipelineSettingsView>, opts);
export const savePipelineSettings = (jobId: string, s: PipelineSettingsInput, opts: Options = {}) => call('PUT', `${job(jobId)}/settings`, s, as<PipelineSettingsView>, opts);

export const getRubric = (jobId: string, roundId: string, opts: Options = {}) => call('GET', `${job(jobId)}/rounds/${encodeURIComponent(roundId)}/rubric`, undefined, as<RoundRubricView>, opts);
export const saveRubric = (jobId: string, roundId: string, parameters: RubricParameter[], opts: Options = {}) =>
  call('PUT', `${job(jobId)}/rounds/${encodeURIComponent(roundId)}/rubric`, { parameters }, as<RoundRubricView>, opts);

export const getPipelineStatuses = (jobId: string, opts: Options = {}) => call('GET', `${job(jobId)}/statuses`, undefined, as<JobPipelineStatuses>, opts);

export const getPiBoard = (jobId: string, opts: Options = {}) => call('GET', `${job(jobId)}/personal-interview`, undefined, as<PiBoard>, opts);
export const updatePiCall = (jobId: string, applicationId: string, status: PiCallStatus, notes: string, opts: Options = {}) =>
  call('PUT', `${job(jobId)}/personal-interview/${encodeURIComponent(applicationId)}`, { status, notes }, as<PiBoard>, opts);

/** A table as a CSV file the browser downloads (Excel-friendly: BOM, quoted cells, CRLF). */
export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    // a leading = + - @ would run as a formula in a spreadsheet
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const text = '\uFEFF' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
