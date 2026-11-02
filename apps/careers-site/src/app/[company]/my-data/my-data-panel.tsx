'use client';

import type { MyData } from '@hireflow/contracts';
import { useEffect, useState } from 'react';
import { PhoneVerify } from '@/components/phone-verify';
import { Button, Spinner } from '@/components/ui';
import { CONTENT } from '@/content';
import { ApiError, deleteMyData, viewMyData } from '@/lib/api';
import { forgetPhoneProof, recallPhoneProof } from '@/lib/phone-proof';

const T = CONTENT.myData;
const date = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(iso),
  );

export function MyDataPanel({ companySlug }: { companySlug: string }) {
  const [phone, setPhone] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<MyData | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  /** True when we re-use the phone the student verified while applying (same tab). */
  const [remembered, setRemembered] = useState(false);

  useEffect(() => {
    const proof = recallPhoneProof(companySlug);
    if (proof) {
      setPhone(proof.phone);
      setToken(proof.otpToken);
      setRemembered(true);
    }
  }, [companySlug]);

  const run = async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setError('');
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : CONTENT.form.errors.generic);
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <p role="status" className="text-sm font-medium text-success">
        {done}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {remembered ? (
        <p className="text-sm">
          {T.continueAs(phone)}{' '}
          <button
            type="button"
            className="font-medium text-accent underline"
            onClick={() => {
              forgetPhoneProof();
              setRemembered(false);
              setToken(null);
              setPhone('');
              setData(null);
            }}
          >
            {T.otherNumber}
          </button>
        </p>
      ) : (
        <PhoneVerify
          companySlug={companySlug}
          phone={phone}
          onPhoneChange={setPhone}
          onVerified={(t) => {
            setToken(t);
            setData(null);
          }}
          disabled={busy}
        />
      )}

      {token && !data && (
        <Button
          variant="primary"
          onClick={async () =>
            setData((await run(() => viewMyData(companySlug, phone, token))) ?? null)
          }
          disabled={busy}
        >
          {busy && <Spinner />}
          {T.load}
        </Button>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {data && !data.candidate && <p className="text-sm">{T.nothing}</p>}

      {data?.candidate && (
        <div className="flex flex-col gap-5 text-sm">
          <dl className="grid gap-1">
            <div>
              <dt className="inline font-medium">{CONTENT.form.labels.name}: </dt>
              <dd className="inline">{data.candidate.name}</dd>
            </div>
            <div>
              <dt className="inline font-medium">{CONTENT.form.labels.email}: </dt>
              <dd className="inline">{data.candidate.email}</dd>
            </div>
            <div>
              <dt className="inline font-medium">{CONTENT.form.labels.phone}: </dt>
              <dd className="inline">{data.candidate.phone}</dd>
            </div>
          </dl>

          <section>
            <h2 className="mb-2 font-semibold">{T.applications}</h2>
            <ul className="flex flex-col gap-2">
              {data.applications.map((a) => (
                <li key={a.applicationId} className="rounded-md border border-border px-3 py-2">
                  <p className="font-medium">{a.jobTitle}</p>
                  <p className="text-muted">
                    {date(a.appliedAt)} · {a.state.toLowerCase()}
                    {a.resumeFileName ? ` · ${a.resumeFileName}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-semibold">{T.consents}</h2>
            <ul className="list-disc pl-5">
              {data.consents.map((c, i) => (
                <li key={i}>
                  {T.purposes[c.purpose] ?? c.purpose} · {date(c.grantedAt)} · v{c.policyVersion}
                  {c.withdrawnAt ? ` · ${T.withdrawn}` : ''}
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-md border border-danger/40 p-4">
            <h2 className="mb-1 font-semibold text-danger">{T.deleteTitle}</h2>
            <p className="mb-3">{T.deleteHelp}</p>
            <label className="mb-3 flex items-start gap-2.5">
              <input
                id="confirm-delete"
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
              <span>{T.deleteConfirm}</span>
            </label>
            <Button
              className="border-danger text-danger"
              disabled={!confirm || busy}
              onClick={async () => {
                const res = await run(() => deleteMyData(companySlug, phone, token!));
                if (res) {
                  forgetPhoneProof();
                  setDone(T.deleted(res.deletedApplications));
                }
              }}
            >
              {busy && <Spinner />}
              {T.deleteButton}
            </Button>
          </section>
        </div>
      )}
    </div>
  );
}
