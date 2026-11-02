'use client';

import { JOB_FORM_LIMITS, type JdContent } from '@hireflow/contracts';
import { useEffect, useState } from 'react';
import { ABOUT_COMPANY_HEADING, COMPANY_LINK_HEADING, HOW_TO_APPLY_HEADING, JD_SECTIONS, jdProblems, jdToText, tidyJd, type JdListField } from '@/lib/jd';
import { Button, Spinner, inputClass } from './ui';

interface Props {
  jd: JdContent;
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

export function JdPanel({ jd, versionLabel, locked, busy, onSave, onRegenerate, onEditingChange }: Props) {
  const [draft, setDraft] = useState<JdContent | null>(null); // non-null while editing
  const [copy, setCopy] = useState<CopyState>('idle');
  const editing = draft !== null;
  const problems = draft ? jdProblems(draft) : [];

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
      await navigator.clipboard.writeText(jdToText(jd));
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

      <div className={busy === 'regenerating' ? 'pointer-events-none opacity-50 transition-opacity' : 'transition-opacity'}>
        {draft ? <JdEditor jd={draft} onChange={setDraft} /> : <JdView jd={jd} />}
      </div>
    </section>
  );
}

export function JdView({ jd }: { jd: JdContent }) {
  return (
    <article className="flex flex-col gap-6 leading-relaxed">
      <header>
        <h3 className="text-2xl font-semibold tracking-tight">{jd.title}</h3>
        <p className="mt-3 text-[15px]">{jd.summary}</p>
      </header>
      {jd.aboutCompany && (
        <section>
          <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{ABOUT_COMPANY_HEADING}</h4>
          <p className="whitespace-pre-line text-[15px]">{jd.aboutCompany}</p>
        </section>
      )}
      {JD_SECTIONS.map(({ field, heading }) =>
        jd[field].length ? (
          <section key={field}>
            <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{heading}</h4>
            <ul className="list-disc space-y-1.5 pl-5 text-[15px] marker:text-muted">
              {jd[field].map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
      {jd.companyUrl && (
        <section>
          <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{COMPANY_LINK_HEADING}</h4>
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
          <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{HOW_TO_APPLY_HEADING}</h4>
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
          Summary
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
