'use client';

import type { Session } from '@hireflow/contracts';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from 'react';
import { logout, switchCompany } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/roles';
import { AssessmentsMenu } from './assessments-menu';
import { Tip, navRowClass } from './sidebar-parts';
import {
  BriefcaseIcon,
  BuildingIcon,
  ChevronDownIcon,
  CloseIcon,
  InboxIcon,
  LogOutIcon,
  MenuIcon,
  PlusCircleIcon,
  PlusIcon,
  SendIcon,
  SettingsIcon,
  SidebarIcon,
  TeamIcon,
  UsersIcon,
} from './icons';

const COLLAPSED_KEY = 'anvexa:sidebar-collapsed';

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Paths under `href` that belong to another item (e.g. /jobs/new is "New job", not "Job postings"). */
  exclude?: string[];
}

const isActive = (pathname: string, item: Pick<NavItem, 'href' | 'exclude'>) =>
  !item.exclude?.includes(pathname) && (pathname === item.href || pathname.startsWith(`${item.href}/`));

/**
 * The dashboard frame: a light-grey, collapsible left sidebar (icons only when collapsed, with tooltips) and the white
 * workspace. On small screens the sidebar becomes a slide-out drawer opened from a slim top bar. Every link points at
 * the existing routes; permissions are still enforced by the API and by <Gate> in session.tsx.
 */
export function AppShell({ session, onChanged, children }: { session: Session; onChanged: () => Promise<void>; children: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);

  // the collapsed / expanded choice is kept across pages and visits (a per-browser convenience only)
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === '1');
    } catch {
      // storage unavailable: start expanded
    }
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1');
      } catch {
        // not remembered, still toggled
      }
      return !c;
    });
  };

  // the drawer closes when the page changes, and on Escape
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  const usable = session.company?.status === 'ACTIVE';
  const home = usable ? '/jobs' : '/admin';

  return (
    <div className="flex min-h-screen bg-background">
      {/* desktop / tablet: persistent sidebar */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 md:flex ${collapsed ? 'w-[60px]' : 'w-[260px]'}`}
        aria-label="Sidebar"
      >
        <SidebarContent session={session} onChanged={onChanged} collapsed={collapsed} onToggle={toggle} home={home} />
      </aside>

      {/* phone: slide-out drawer */}
      <div className={`fixed inset-0 z-50 md:hidden ${drawer ? '' : 'pointer-events-none'}`} aria-hidden={!drawer}>
        <div className={`absolute inset-0 bg-black/30 transition-opacity ${drawer ? 'opacity-100' : 'opacity-0'}`} onClick={() => setDrawer(false)} />
        <aside
          className={`absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col border-r border-border bg-sidebar shadow-xl transition-transform duration-200 ${drawer ? 'translate-x-0' : '-translate-x-full'}`}
          aria-label="Sidebar"
          inert={!drawer}
        >
          <SidebarContent session={session} onChanged={onChanged} collapsed={false} onClose={() => setDrawer(false)} home={home} />
        </aside>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-background/95 px-2 backdrop-blur md:hidden">
          <button type="button" onClick={() => setDrawer(true)} className={iconButton} aria-label="Open the menu" aria-expanded={drawer}>
            <MenuIcon />
          </button>
          <Link href={home} className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <Logo /> Anvexa
          </Link>
          {usable && (
            <Link href="/jobs/new" className={`${iconButton} ml-auto`} aria-label="New job">
              <PlusIcon />
            </Link>
          )}
        </header>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

const iconButton =
  'inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30';

/** Anvexa's mark: a navy tile with a soft glow. */
function Logo() {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-hover text-[14px] font-bold text-white shadow-md shadow-accent/30"
    >
      A
    </span>
  );
}

function SidebarContent({
  session,
  onChanged,
  collapsed,
  onToggle,
  onClose,
  home,
}: {
  session: Session;
  onChanged: () => Promise<void>;
  collapsed: boolean;
  onToggle?: () => void;
  onClose?: () => void;
  home: string;
}) {
  const pathname = usePathname();
  const usable = session.company?.status === 'ACTIVE';
  const admin = session.company?.role === 'COMPANY_ADMIN';

  const main: NavItem[] = usable
    ? [
        { href: '/jobs', label: 'Job postings', icon: BriefcaseIcon, exclude: ['/jobs/new'] },
        { href: '/publish', label: 'Publish', icon: SendIcon },
        { href: '/applications', label: 'Applications', icon: InboxIcon },
        { href: '/shortlisted', label: 'Shortlisted candidates', icon: UsersIcon },
      ]
    : [];
  const bottom: NavItem[] = [
    ...(usable ? [{ href: '/company', label: 'Company settings', icon: SettingsIcon }] : []),
    ...(usable && admin ? [{ href: '/team', label: 'Team', icon: TeamIcon }] : []),
    ...(session.user.isPlatformAdmin ? [{ href: '/admin', label: 'Companies', icon: BuildingIcon }] : []),
  ];

  return (
    <div className="flex h-full flex-col">
      {/* top: logo, collapse, New job */}
      <div className={`flex items-center gap-1 px-2 pt-2 ${collapsed ? 'flex-col' : ''}`}>
        <Link
          href={home}
          className={`flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-[17px] font-bold tracking-tight hover:bg-hover ${collapsed ? 'justify-center px-0' : 'flex-1'}`}
          aria-label="Anvexa home"
        >
          <Logo />
          {!collapsed && <span className="truncate">Anvexa</span>}
        </Link>
        {onToggle && (
          <Tip label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} show={collapsed}>
            <button type="button" onClick={onToggle} className={iconButton} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed}>
              <SidebarIcon />
            </button>
          </Tip>
        )}
        {onClose && (
          <button type="button" onClick={onClose} className={iconButton} aria-label="Close the menu">
            <CloseIcon />
          </button>
        )}
      </div>

      {usable && (
        <div className="px-2 pt-4">
          <NavLink item={{ href: '/jobs/new', label: 'New job', icon: PlusCircleIcon }} collapsed={collapsed} active={pathname === '/jobs/new'} />
        </div>
      )}

      {/* main navigation */}
      <nav aria-label="Main" className="mt-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2">
        {main.map((n) => (
          <NavLink key={n.href} item={n} collapsed={collapsed} active={isActive(pathname, n)} />
        ))}
        {usable && <AssessmentsMenu variant="sidebar" collapsed={collapsed} />}
      </nav>

      {/* bottom: settings, team, profile */}
      <div className="flex flex-col gap-0.5 border-t border-border px-2 py-3">
        {bottom.map((n) => (
          <NavLink key={n.href} item={n} collapsed={collapsed} active={isActive(pathname, n)} />
        ))}
        <ProfileMenu session={session} onChanged={onChanged} collapsed={collapsed} />
      </div>
    </div>
  );
}

function NavLink({ item, collapsed, active }: { item: NavItem; collapsed: boolean; active: boolean }) {
  const I = item.icon;
  return (
    <Tip label={item.label} show={collapsed}>
      <Link href={item.href} aria-current={active ? 'page' : undefined} aria-label={collapsed ? item.label : undefined} className={navRowClass(active, collapsed)}>
        <I />
        {!collapsed && <span className="truncate">{item.label}</span>}
      </Link>
    </Tip>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

/** The HR user at the bottom: name and company; opens a menu with the company switcher and Log out. */
function ProfileMenu({ session, onChanged, collapsed }: { session: Session; onChanged: () => Promise<void>; collapsed: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const role = session.company ? ROLE_LABEL[session.company.role] : session.user.isPlatformAdmin ? 'Platform Admin' : '';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const signOut = async () => {
    setBusy(true);
    await logout().catch(() => undefined);
    router.replace('/login');
    await onChanged();
  };

  const onSwitch = async (companyId: string) => {
    setBusy(true);
    try {
      await switchCompany(companyId);
      setOpen(false);
      router.push('/jobs');
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={box} className="relative">
      <Tip label={session.user.name} show={collapsed && !open}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={collapsed ? `Account: ${session.user.name}` : undefined}
          className={`${navRowClass(false, collapsed)} ${collapsed ? '' : 'h-auto py-1.5'}`}
        >
          <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent ring-1 ring-accent/15">
            {initials(session.user.name)}
          </span>
          {!collapsed && (
            <>
              <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                <span className="truncate font-semibold text-foreground">{session.user.name}</span>
                <span className="truncate text-xs text-muted">{session.company?.name ?? role}</span>
              </span>
              <ChevronDownIcon className={`h-4 w-4 text-muted transition-transform ${open ? '' : 'rotate-180'}`} />
            </>
          )}
        </button>
      </Tip>
      {open && (
        <div
          role="menu"
          className={`absolute bottom-full z-50 mb-1 flex w-64 flex-col rounded-xl border border-border bg-surface p-1.5 shadow-card-hover ${collapsed ? 'left-0' : 'left-0 right-0 w-auto'}`}
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-medium">{session.user.name}</p>
            <p className="truncate text-xs text-muted">{[role, session.company?.name].filter(Boolean).join(' · ')}</p>
          </div>
          {session.companies.length > 1 && (
            <label className="flex flex-col gap-1 px-2.5 pb-2 text-xs text-muted">
              Company
              <select
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                value={session.company?.id ?? ''}
                disabled={busy}
                onChange={(e) => void onSwitch(e.target.value)}
              >
                {!session.company && <option value="">Choose a company</option>}
                {session.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            disabled={busy}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground hover:bg-hover disabled:opacity-50"
          >
            <LogOutIcon className="h-4 w-4" /> Log out
          </button>
        </div>
      )}
    </div>
  );
}
