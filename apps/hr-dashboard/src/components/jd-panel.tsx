'use client';

import { JOB_FORM_LIMITS, reviewJd, type CompanyProfile, type JdContent, type JdReviewIssue, type JobForm } from '@hireflow/contracts';
import { useEffect, useMemo, useState } from 'react';
import {
  ABOUT_COMPANY_HEADING,
  ABOUT_ROLE_HEADING,
  COMPANY_LINK_HEADING,
  HOW_TO_APPLY_HEADING,
  JD_SECTIONS,
  jdProblems,
  jdToText,
  jobMeta,
  tidyJd,
  type JdListField,
} from '@/lib/jd';
import { Button, Spinner, inputClass } from './ui';

interface Props {
  jd: JdContent;
  /** HR's job requirements: shown as the JD header and used to fact-check the text. */
  form: JobForm;
  /** The company details this version was written from (fact-check source for company facts and benefits). */
  company: CompanyProfile | null;
  /** e.g. "Version 2 · edited by HR" */
  versionLabel: string;
  /** Approved jobs are read-only. */
  locked: boolean;
  busy: 'regenerating' | 'saving' | null;
  /** Saves the edit as a new version. Resolve true to leave edit mode. */
  onSave: (jd: JdContent) => Promise<boolean>;
  onRegenerate: () => void;
  onEditingChange: (editing: boolean) => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

export function JdPanel({ jd, form, company, versionLabel, locked, busy, onSave, onRegenerate, onEditingChange }: Props) {
  const [draft, setDraft] = useState<JdContent | null>(null); // non-null while editing
  const [copy, setCopy] = useState<CopyState>('idle');
  const editing = draft !== null;
  const problems = draft ? jdProblems(draft) : [];
  // re-checked live while HR edits, so a fix (or a newly typed fact) shows up immediately
  const shown = draft ?? jd;
  const review = useMemo(() => reviewJd(form, tidyJd(shown), company), [form, shown, company]);

  useEffect(() => {
    if (copy === 'idle') return;
    const t = setTimeout(() => setCopy('idle'), 2500);
    return () => clearTimeout(t);
  }, [copy]);

  const setEditing = (next: JdContent | null) => {
    setDraft(next);
    onEditingChange(next !== null);
  };

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(jdToText(jd, form));
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };

  const save = async () => {
    if (!draft) return;
    if (await onSave(tidyJd(draft))) setEditing(null);
  };

  const cancel = () => {
    if (draft && JSON.stringify(tidyJd(draft)) !== JSON.stringify(tidyJd(jd)) && !window.confirm('Discard your changes?')) return;
    setEditing(null);
  };

  return (
    <section aria-labelledby="jd-heading" aria-busy={busy !== null} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="jd-heading" className="text-lg font-semibold">
            Job description
          </h2>
          <p className="mt-1 text-sm text-muted">
            {versionLabel}
            {!locked && ' · Review it carefully before approving.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button variant="primary" onClick={save} disabled={problems.length > 0 || busy !== null}>
                {busy === 'saving' && <Spinner />}
                {busy === 'saving' ? 'Saving…' : 'Save as new version'}
              </Button>
              <Button onClick={cancel} disabled={busy !== null}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {!locked && (
                <>
                  <Button onClick={() => setEditing(structuredClone(jd))} disabled={busy !== null}>
                    Edit
                  </Button>
                  <Button onClick={onRegenerate} disabled={busy !== null}>
                    {busy === 'regenerating' && <Spinner />}
                    {busy === 'regenerating' ? 'Regenerating…' : 'Regenerate'}
                  </Button>
                </>
              )}
              <Button onClick={doCopy} disabled={busy !== null}>
                {copy === 'copied' ? 'Copied ✓' : 'Copy'}
              </Button>
            </>
          )}
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {copy === 'copied' ? 'Job description copied to clipboard.' : copy === 'failed' ? 'Copy failed.' : ''}
      </p>
      {copy === 'failed' && (
        <p className="text-sm text-danger" role="alert">
          Could not access the clipboard. Select the text and copy it manually.
        </p>
      )}

      {editing && problems.length > 0 && (
        <ul className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {!locked && <FactCheck issues={review} editing={editing} />}

      <div className={busy === 'regenerating' ? 'pointer-events-none opacity-50 transition-opacity' : 'transition-opacity'}>
        {draft ? <JdEditor jd={draft} onChange={setDraft} /> : <JdView jd={jd} form={form} />}
      </div>
    </section>
  );
}

const sectionHeading = 'mb-3 border-b border-border pb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted';

/**
 * The JD as a job posting: title and the facts from HR's form (location, work mode, type, experience) as a header,
 * then the written sections, with the skills as tags - skills come from the form, never from the AI.
 */
export function JdView({ jd, form }: { jd: JdContent; form?: JobForm }) {
  const [first, ...rest] = JD_SECTIONS;
  const section = ({ field, heading }: (typeof JD_SECTIONS)[number]) =>
    jd[field].length ? (
      <section key={field}>
        <h4 className={sectionHeading}>{heading}</h4>
        <ul className="flex flex-col gap-2 text-[15px]">
          {jd[field].map((item, i) => (
            <li key={i} className="flex gap-3">
              <span aria-hidden="true" className="mt-[0.6rem] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  return (
    <article className="flex flex-col gap-7 leading-relaxed">
      <header className="flex flex-col gap-3">
        <h3 className="text-2xl font-semibold tracking-tight">{jd.title}</h3>
        {form && (
          <ul className="flex flex-wrap gap-x-2 gap-y-1 text-sm text-muted" aria-label="Job details">
            {jobMeta(form).map((m, i) => (
              <li key={m} className="flex items-center gap-2">
                {i > 0 && <span aria-hidden="true">·</span>}
                {m}
              </li>
            ))}
          </ul>
        )}
      </header>
      <section>
        <h4 className={sectionHeading}>{ABOUT_ROLE_HEADING}</h4>
        <div className="flex flex-col gap-3 text-[15px]">
          {jd.summary
            .split(/\n\s*\n/)
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p, i) => (
              <p key={i}>{p}</p>
            ))}
        </div>
      </section>
      {jd.aboutCompany && (
        <section>
          <h4 className={sectionHeading}>{ABOUT_COMPANY_HEADING}</h4>
          <p className="whitespace-pre-line text-[15px]">{jd.aboutCompany}</p>
        </section>
      )}
      {first && section(first)}
      {form && (
        <section>
          <h4 className={sectionHeading}>Technical Skills</h4>
          <ul className="flex flex-wrap gap-2" aria-label="Required skills">
            {form.mustHaveSkills.map((s) => (
              <li key={s} className="rounded-full border border-accent/30 bg-accent-soft px-3 py-1 text-sm font-medium">
                {s}
              </li>
            ))}
          </ul>
          {form.niceToHaveSkills.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="Good-to-have skills">
              {form.niceToHaveSkills.map((s) => (
                <li key={s} className="rounded-full border border-border px-3 py-1 text-sm text-muted">
                  {s}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {rest.map(section)}
      {jd.companyUrl && (
        <section>
          <h4 className={sectionHeading}>{COMPANY_LINK_HEADING}</h4>
          <p className="text-[15px]">
            Learn more about us at{' '}
            <a href={jd.companyUrl} target="_blank" rel="noreferrer noopener" className="break-all text-accent hover:underline">
              {jd.companyUrl}
            </a>
          </p>
        </section>
      )}
      {jd.careersUrl && (
        <section>
          <h4 className={sectionHeading}>{HOW_TO_APPLY_HEADING}</h4>
          <p className="text-[15px]">
            See all our openings and apply at{' '}
            <a href={jd.careersUrl} target="_blank" rel="noreferrer noopener" className="break-all text-accent hover:underline">
              {jd.careersUrl}
            </a>
          </p>
        </section>
      )}
    </article>
  );
}

function JdEditor({ jd, onChange }: { jd: JdContent; onChange: (jd: JdContent) => void }) {
  const setList = (field: JdListField, items: string[]) => onChange({ ...jd, [field]: items });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="jd-title" className="text-sm font-medium">
          Job title
        </label>
        <input id="jd-title" className={inputClass} value={jd.title} maxLength={JOB_FORM_LIMITS.titleMax} onChange={(e) => onChange({ ...jd, title: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="jd-summary" className="text-sm font-medium">
          {ABOUT_ROLE_HEADING} <span className="font-normal text-muted">(leave a blank line between paragraphs)</span>
        </label>
        <textarea
          id="jd-summary"
          rows={5}
          className={inputClass}
          value={jd.summary}
          onChange={(e) => onChange({ ...jd, summary: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="jd-about" className="text-sm font-medium">
          {ABOUT_COMPANY_HEADING} <span className="font-normal text-muted">(optional)</span>
        </label>
        <textarea
          id="jd-about"
          rows={4}
          className={inputClass}
          value={jd.aboutCompany}
          onChange={(e) => onChange({ ...jd, aboutCompany: e.target.value })}
        />
      </div>
      {JD_SECTIONS.map(({ field, heading, optional }) => (
        <fieldset key={field} className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">
            {heading}
            {optional && <span className="font-normal text-muted"> (optional)</span>}
          </legend>
          {jd[field].map((item, i) => (
            <div key={i} className="flex items-start gap-2">
              <textarea
                rows={2}
                aria-label={`${heading} item ${i + 1}`}
                className={inputClass}
                value={item}
                onChange={(e) => setList(field, jd[field].map((x, j) => (j === i ? e.target.value : x)))}
              />
              <Button
                variant="ghost"
                aria-label={`Remove ${heading} item ${i + 1}`}
                onClick={() => setList(field, jd[field].filter((_, j) => j !== i))}
              >
                ×
              </Button>
            </div>
          ))}
          <div>
            <Button variant="ghost" onClick={() => setList(field, [...jd[field], ''])}>
              + Add item
            </Button>
          </div>
        </fieldset>
      ))}
      {jd.companyUrl && (
        <div className="rounded-md border border-border px-4 py-3 text-sm">
          <p className="font-medium">{COMPANY_LINK_HEADING}</p>
          <p className="mt-1 text-muted">
            Added automatically from the website in your company profile: <span className="break-all">{jd.companyUrl}</span>
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Fact check of the shown version against HR's requirements (reviewJd from @hireflow/contracts - the same check the
 * API runs after generation). It only flags; HR decides. Errors = facts HR never gave; warnings = depth and wording.
 */
function FactCheck({ issues, editing }: { issues: JdReviewIssue[]; editing: boolean }) {
  if (!issues.length) {
    return (
      <p role="status" className="flex items-center gap-2 rounded-md border border-success/40 bg-success-soft px-4 py-2.5 text-sm text-success">
        <span aria-hidden="true">✓</span>
        Fact check passed: nothing beyond your job requirements and company profile.
      </p>
    );
  }
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return (
    <div role="status" className="flex flex-col gap-3 rounded-md border border-border px-4 py-3 text-sm">
      <p className="font-medium">
        Fact check{editing ? ' (updates as you edit)' : ''}: {errors.length ? 'review before approving' : 'suggestions'}
      </p>
      {errors.length > 0 && (
        <div className="rounded-md bg-danger-soft px-3 py-2 text-danger">
          <p className="font-medium">Not in your job requirements</p>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((i) => (
              <li key={i.code + i.message}>{i.message}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs">Edit these lines out, or keep them if they are true for this job.</p>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md bg-accent-soft px-3 py-2">
          <p className="font-medium">Writing and seniority</p>
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((i) => (
              <li key={i.code + i.message}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
