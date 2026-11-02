'use client';

import type { JobScreeningSettings } from '@hireflow/contracts';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { getScreeningSettings, parseMinAtsScore, saveScreeningSettings } from '@/lib/ats-api';
import { ScreeningScoreField } from './screening-score-field';
import { Button, Spinner } from './ui';

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; notReady: boolean }
  | { kind: 'ready'; value: JobScreeningSettings };

/**
 * Job page: the private minimum ATS score. Editable any time (it is not part of the JD, so an approved job can still
 * change it); a new value re-sorts candidates HR has not decided on yet.
 */
export function ScreeningSettingsCard({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const value = await getScreeningSettings(jobId, { signal });
        setState({ kind: 'ready', value });
        setEditing(!value.settings);
        setText(value.settings ? String(value.settings.minAtsScore) : '');
      } catch (err) {
        if (signal?.aborted) return;
        setState({ kind: 'error', message: messageOf(err), notReady: err instanceof ApiError && err.code === 'ATS_NOT_READY' });
      }
    },
    [jobId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const save = async () => {
    const parsed = parseMinAtsScore(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    // a new or higher minimum re-sorts screened students: those now below it are emailed the rejection at once
    const current = state.kind === 'ready' ? state.value.settings?.minAtsScore : undefined;
    if (
      (current === undefined || parsed.value.minAtsScore > current) &&
      !window.confirm(
        `Screened students below ${parsed.value.minAtsScore}% who have not been emailed yet will get the rejection email right away. Continue?`,
      )
    ) {
      return;
    }
    setError('');
    setSaving(true);
    try {
      const value = await saveScreeningSettings(jobId, parsed.value);
      setState({ kind: 'ready', value });
      setEditing(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="screening-heading" className="flex flex-col gap-3">
      <h2 id="screening-heading" className="text-base font-semibold">
        Resume screening (private)
      </h2>
      {state.kind === 'loading' && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Loading…
        </p>
      )}
      {state.kind === 'error' && (
        <p className="text-sm text-danger">
          {state.notReady ? 'Resume screening is not set up on the server yet.' : state.message}
        </p>
      )}
      {state.kind === 'ready' && !editing && state.value.settings && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            Minimum ATS score: <span className="font-semibold">{state.value.settings.minAtsScore}%</span>
            <span className="block text-xs text-muted">
              Only your HR team sees this. Raising it sends the rejection email to screened students who are now below it.
            </span>
          </p>
          <Button onClick={() => setEditing(true)}>Change</Button>
        </div>
      )}
      {state.kind === 'ready' && editing && (
        <div className="flex flex-col gap-3">
          {!state.value.settings && (
            <p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm">
              Set the minimum ATS score before publishing this job.
            </p>
          )}
          <ScreeningScoreField
            id="minAtsScoreEdit"
            value={text}
            error={error}
            onChange={(v) => {
              setText(v);
              setError('');
            }}
          />
          <div className="flex gap-2">
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving && <Spinner />}
              Save
            </Button>
            {state.value.settings && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setText(String(state.value.settings!.minAtsScore));
                  setError('');
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
