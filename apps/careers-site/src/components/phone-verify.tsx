'use client';

import Script from 'next/script';
import { useState } from 'react';
import { CONTENT } from '@/content';
import { ApiError, sendOtp, verifyOtp } from '@/lib/api';
import { Button, Field, Spinner, describedBy, inputClass } from './ui';

/**
 * Cloudflare Turnstile site key. Empty = no CAPTCHA (local dev). Must match TURNSTILE_SECRET_KEY on the API.
 * VERIFY (owner): widget script URL and the hidden "cf-turnstile-response" input, against Cloudflare's client-side docs.
 */
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';

type OtpState = 'idle' | 'sending' | 'sent' | 'verifying' | 'verified';

interface Props {
  companySlug: string;
  phone: string;
  onPhoneChange: (phone: string) => void;
  /** Called with the signed phone proof once verified, or null when the number changes. */
  onVerified: (otpToken: string | null) => void;
  /** Error from the parent form for the phone field. */
  error?: string;
  disabled?: boolean;
}

const T = CONTENT.form;

/** Mobile number + "Send code" + 6-digit code. Used by the apply form and the "my data" page. */
export function PhoneVerify({ companySlug, phone, onPhoneChange, onVerified, error, disabled }: Props) {
  const [state, setState] = useState<OtpState>('idle');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [ownError, setOwnError] = useState('');
  const shownError = ownError || error;

  const changePhone = (value: string) => {
    onPhoneChange(value);
    if (state !== 'idle') {
      // A new number must be verified again.
      setState('idle');
      setCode('');
      setNote('');
      onVerified(null);
    }
  };

  const send = async () => {
    setOwnError('');
    const captchaToken = TURNSTILE_SITE_KEY
      ? (document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')?.value ?? '')
      : undefined;
    if (TURNSTILE_SITE_KEY && !captchaToken) return setOwnError(T.otp.captcha);
    const before = state;
    setState('sending');
    try {
      const res = await sendOtp(companySlug, phone, captchaToken);
      setState('sent');
      setNote(res.devCode ? `${T.otp.sent} ${T.otp.devNotice(res.devCode)}` : T.otp.sent);
    } catch (err) {
      // A failed "Resend" (e.g. "wait 30 seconds") keeps the code box: the code sent earlier still works.
      setState(before === 'sent' ? 'sent' : 'idle');
      setOwnError(err instanceof ApiError ? err.message : T.errors.generic);
    } finally {
      // Turnstile tokens are single-use.
      (window as { turnstile?: { reset?: () => void } }).turnstile?.reset?.();
    }
  };

  const verify = async () => {
    setOwnError('');
    setState('verifying');
    try {
      const res = await verifyOtp(companySlug, phone, code);
      setState('verified');
      setNote('');
      onVerified(res.otpToken);
    } catch (err) {
      setState('sent');
      setOwnError(err instanceof ApiError ? err.message : T.errors.generic);
    }
  };

  return (
    <>
      <Field id="phone" label={T.labels.phone} required hint={state === 'verified' ? undefined : T.hints.phone} error={shownError}>
        <div className="flex gap-2">
          <input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className={inputClass}
            value={phone}
            aria-invalid={!!shownError}
            aria-describedby={describedBy('phone', T.hints.phone, shownError)}
            onChange={(ev) => changePhone(ev.target.value)}
            disabled={disabled || state === 'verifying'}
          />
          {state === 'verified' ? (
            <span className="flex shrink-0 items-center text-sm font-medium text-success">{T.otp.verified}</span>
          ) : (
            <Button className="shrink-0" onClick={send} disabled={disabled || state === 'sending' || !phone.trim()}>
              {state === 'sending' && <Spinner />}
              {state === 'idle' || state === 'sending' ? T.otp.send : T.otp.resend}
            </Button>
          )}
        </div>
      </Field>

      {/* Hidden, not removed, once verified: Turnstile renders the widget only when its script loads, so a widget
          removed and added again (student changes the number) would stay empty and block "Send code". */}
      {TURNSTILE_SITE_KEY && (
        <div hidden={state === 'verified'}>
          <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" />
          <div className="cf-turnstile" data-sitekey={TURNSTILE_SITE_KEY} />
        </div>
      )}

      {(state === 'sent' || state === 'verifying') && (
        <Field id="otp" label={T.labels.otp} required hint={note}>
          <div className="flex gap-2">
            <input
              id="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className={inputClass}
              value={code}
              onChange={(ev) => setCode(ev.target.value.replace(/\D/g, ''))}
            />
            <Button variant="primary" className="shrink-0" onClick={verify} disabled={code.length !== 6 || state === 'verifying'}>
              {state === 'verifying' && <Spinner />}
              {T.otp.verify}
            </Button>
          </div>
        </Field>
      )}
    </>
  );
}
