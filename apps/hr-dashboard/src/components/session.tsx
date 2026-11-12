'use client';

import type { Session } from '@hireflow/contracts';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, UNAUTHENTICATED_EVENT, getSession } from '@/lib/api';
import { AppShell } from './app-shell';
import { Button, Card, ErrorNotice, Spinner } from './ui';

/**
 * Who is logged in. The browser only displays this: every permission is enforced again by the API,
 * which derives the company from the session cookie, never from anything the browser sends.
 */
interface SessionValue {
  session: Session;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
/** Always available (also on /login and /invite): reload the session after logging in. */
const RefreshContext = createContext<() => Promise<void>>(async () => {});
export const useRefreshSession = () => useContext(RefreshContext);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession() outside <SessionProvider>');
  return value;
}

export const isCompanyAdmin = (s: Session) => s.company?.role === 'COMPANY_ADMIN';

const PUBLIC_PATHS = ['/login', '/signup', '/invite/', '/forgot-password', '/reset-password/'];
/** Logged in, but no company yet: the only page that works without one. */
const REGISTER_PATH = '/register-company';
const isPublic = (path: string) => PUBLIC_PATHS.some((p) => path === p || path.startsWith(p));

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'anonymous' } | { kind: 'ready'; session: Session };

export function SessionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const session = await getSession();
      setState(session ? { kind: 'ready', session } : { kind: 'anonymous' });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof ApiError ? err.message : 'Something went wrong.' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // any API call answering 401 (expired or revoked session) sends the user back to the login page
  useEffect(() => {
    const onUnauthenticated = () => setState({ kind: 'anonymous' });
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
  }, []);

  const publicPage = isPublic(pathname);
  const session = state.kind === 'ready' ? state.session : null;
  const platformOnly = !!session && session.user.isPlatformAdmin && !session.company;
  // a new HR account (or one whose memberships were all disabled) must register a company first
  const needsCompany = !!session && !session.user.isPlatformAdmin && session.companies.length === 0;
  const allowedWithoutCompany = pathname === REGISTER_PATH || pathname.startsWith('/admin');

  useEffect(() => {
    if (state.kind === 'anonymous' && !publicPage) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if (platformOnly && !publicPage && !allowedWithoutCompany) router.replace('/admin');
    if (needsCompany && !publicPage && pathname !== REGISTER_PATH) router.replace(REGISTER_PATH);
  }, [state.kind, publicPage, platformOnly, needsCompany, allowedWithoutCompany, pathname, router]);

  if (publicPage) return <RefreshContext.Provider value={load}>{children}</RefreshContext.Provider>;
  if (state.kind === 'error') {
    return (
      <Page>
        <ErrorNotice title="Could not reach Anvexa" message={state.message} action={<Button onClick={() => load()}>Try again</Button>} />
      </Page>
    );
  }
  if (!session || (platformOnly && !allowedWithoutCompany) || (needsCompany && pathname !== REGISTER_PATH)) {
    return (
      <Page>
        <Card className="flex min-h-40 items-center justify-center gap-3 text-muted">
          <Spinner className="text-muted" /> Loading…
        </Card>
      </Page>
    );
  }

  return (
    <RefreshContext.Provider value={load}>
      <SessionContext.Provider value={{ session, refresh: load }}>
        {/* the shared frame of every HR page: collapsible sidebar + white workspace (app-shell.tsx) */}
        <AppShell session={session} onChanged={load}>
          <Gate session={session} pathname={pathname}>
            {children}
          </Gate>
        </AppShell>
      </SessionContext.Provider>
    </RefreshContext.Provider>
  );
}

/** Explains why a page is unavailable instead of showing API errors. The API enforces the same rules. */
function Gate({ session, pathname, children }: { session: Session; pathname: string; children: ReactNode }) {
  if (pathname.startsWith('/admin')) {
    return session.user.isPlatformAdmin ? children : <Notice title="Platform Admins only" text="This page manages all companies on Anvexa." />;
  }
  if (pathname === REGISTER_PATH) return children;
  if (!session.company) {
    return <Notice title="Choose a company" text="Pick one of your companies in your account menu at the bottom of the sidebar." />;
  }
  if (session.company.status === 'SUSPENDED') {
    return (
      <Notice
        title={`${session.company.name} is suspended`}
        text="Jobs and recruitment data are unavailable while the company account is suspended. Contact Anvexa support."
      />
    );
  }
  if (pathname.startsWith('/team') && !isCompanyAdmin(session)) {
    return <Notice title="Company Admins only" text="Ask your Company Admin to invite or manage team members." />;
  }
  return children;
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <Page>
      <Card className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted">{text}</p>
      </Card>
    </Page>
  );
}

const Page = ({ children }: { children: ReactNode }) => <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">{children}</main>;
