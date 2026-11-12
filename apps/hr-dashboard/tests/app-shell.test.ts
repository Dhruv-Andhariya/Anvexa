import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@hireflow/contracts';

let pathname = '/jobs';
vi.mock('next/navigation', () => ({ usePathname: () => pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const { AppShell } = await import('../src/components/app-shell');

const session = (role: 'COMPANY_ADMIN' | 'RECRUITER', over: Partial<Session> = {}) =>
  ({
    user: { id: 'u1', name: 'Priya Shah', email: 'priya@example.com', isPlatformAdmin: false },
    company: { id: 'c1', name: 'Pattern Labs', role, status: 'ACTIVE' },
    companies: [{ id: 'c1', name: 'Pattern Labs', role, status: 'ACTIVE' }],
    ...over,
  }) as unknown as Session;

const render = (s: Session, path = '/jobs') => {
  pathname = path;
  return renderToStaticMarkup(createElement(AppShell, { session: s, onChanged: async () => undefined }, createElement('main', null, 'page')));
};

describe('the dashboard sidebar (app-shell)', () => {
  it('links every existing HR page, with New job at the top and the account at the bottom', () => {
    const html = render(session('COMPANY_ADMIN'));
    for (const href of ['/jobs/new', '/jobs', '/publish', '/applications', '/shortlisted', '/assessments', '/company', '/team']) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain('New job');
    expect(html).toContain('Priya Shah');
    expect(html.indexOf('New job')).toBeLessThan(html.indexOf('Job postings'));
    expect(html.indexOf('Job postings')).toBeLessThan(html.indexOf('Company settings'));
    expect(html).toContain('<main>page</main>');
  });

  it('marks the current page, and /jobs/new as New job rather than Job postings', () => {
    expect(render(session('RECRUITER'), '/applications')).toMatch(/aria-current="page"[^>]*href="\/applications"|href="\/applications"[^>]*aria-current="page"/);
    const onNew = render(session('RECRUITER'), '/jobs/new');
    expect(onNew).toMatch(/href="\/jobs\/new" aria-current="page"|aria-current="page"[^>]*href="\/jobs\/new"/);
    expect(onNew).not.toMatch(/href="\/jobs" aria-current="page"/);
  });

  it('shows Team to Company Admins only, and Companies to Platform Admins only (the API still enforces both)', () => {
    expect(render(session('RECRUITER'))).not.toContain('href="/team"');
    expect(render(session('RECRUITER'))).not.toContain('href="/admin"');
    const platform = render(session('RECRUITER', { user: { id: 'u', name: 'Ops', email: 'o@x.com', isPlatformAdmin: true } } as never));
    expect(platform).toContain('href="/admin"');
  });

  it('a suspended company gets no job navigation', () => {
    const html = render(session('COMPANY_ADMIN', { company: { id: 'c1', name: 'Pattern Labs', role: 'COMPANY_ADMIN', status: 'SUSPENDED' } } as never));
    expect(html).not.toContain('href="/jobs/new"');
    expect(html).not.toContain('href="/applications"');
  });
});
