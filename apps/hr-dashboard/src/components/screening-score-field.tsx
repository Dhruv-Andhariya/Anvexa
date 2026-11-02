'use client';

import { Field, describedBy, inputClass } from './ui';

export const MIN_ATS_HINT =
  'Private to your HR team: never shown in the job description, posts or careers page. Students scoring at least this appear in Shortlisted Students; students below it get the rejection email automatically.';

/** "Minimum ATS score" box (0-100). The value is the raw text; parse it with parseMinAtsScore. */
export function ScreeningScoreField({
  value,
  error,
  onChange,
  id = 'minAtsScore',
}: {
  value: string;
  error?: string;
  onChange: (value: string) => void;
  id?: string;
}) {
  return (
    <Field id={id} label="Minimum ATS score (%)" required hint={MIN_ATS_HINT} error={error}>
      <input
        id={id}
        name={id}
        inputMode="numeric"
        placeholder="e.g. 75"
        className={`${inputClass} w-32`}
        value={value}
        maxLength={4}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error ? undefined : 'hint', error)}
      />
    </Field>
  );
}
