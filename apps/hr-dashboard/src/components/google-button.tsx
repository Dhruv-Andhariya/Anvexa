'use client';

import { useEffect, useState } from 'react';
import { getAuthProviders, googleSignInUrl } from '@/lib/api';

/**
 * "Continue with Google" (login and sign-up). A plain link: the browser goes to the API, then Google, then back.
 * Hidden until the API says Google sign-in is configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
 */
export function GoogleButton({ next, label = 'Continue with Google' }: { next?: string; label?: string }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    void getAuthProviders().then((p) => live && setEnabled(p.google));
    return () => {
      live = false;
    };
  }, []);
  if (!enabled) return null;

  return (
    <>
      <a
        href={googleSignInUrl(next)}
        className="inline-flex items-center justify-center gap-2.5 rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground hover:bg-accent-soft focus:outline-none focus:ring-2 focus:ring-accent/40"
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </svg>
        {label}
      </a>
      <div className="flex items-center gap-3 text-xs text-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}

/** Messages for /login?oauth_error=<reason> (set by the API's Google callback). */
export const GOOGLE_ERRORS: Record<string, string> = {
  cancelled: 'Google sign-in was cancelled.',
  expired: 'The Google sign-in took too long or was opened in another browser. Please try again.',
  not_configured: 'Google sign-in is not set up on this server yet.',
  unreachable: 'Could not reach Google. Please try again.',
  rejected: 'Google sign-in did not work. Please try again.',
  unverified_email: 'Your Google account email is not verified, so it cannot be used here.',
  account_disabled: 'This ANVEXA account is disabled. Contact your Company Admin.',
  account_mismatch: 'This email is already linked to a different Google account. Log in with your password instead.',
};
