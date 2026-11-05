import { describe, expect, it } from 'vitest';
import { DecisionEmailSender, isTemporaryTunnel } from '../../src/modules/ats/decision-email.sender';

/**
 * A shortlist email must never carry an AI screening link that does not open. A Cloudflare quick tunnel gets a new
 * address on every restart and the old one stops existing; when the tunnel in CAREERS_SITE_URL is not running, the
 * email waits in the queue (no attempt used) and goes out by itself once the link opens again.
 */

function fakeDb() {
  const emails = [{ id: 'e1', tenant_id: 't1', application_id: 'a1', kind: 'SHORTLIST', attempts: 1, sent_at: null as Date | null }];
  const state = { status: 'QUEUED', lastError: null as string | null, invites: 0, claimed: false };
  const db = {
    // like the real claim: a held email is due again only later (next_attempt_at), so one tick claims it once
    $queryRaw: async () => {
      if (state.claimed || state.status !== 'QUEUED') return [];
      state.claimed = true;
      state.status = 'SENDING';
      return emails;
    },
    application: { findFirst: async () => ({ email: 'asha@example.com', jobId: 'j1', candidate: { name: 'Asha Patel', email: 'asha@example.com' } }) },
    job: { findFirst: async () => ({ title: 'AI Engineer' }) },
    companyProfile: { findUnique: async () => ({ name: 'Acme', website: null, careersUrl: null }) },
    tenant: { findUnique: async () => ({ name: 'Acme' }) },
    screeningInvite: {
      upsert: async () => {
        state.invites++;
        return {};
      },
      updateMany: async () => ({ count: 1 }),
    },
    candidateEmail: {
      updateMany: async ({ data }: { data: { status: string; lastError?: string | null } }) => {
        state.status = data.status;
        if ('lastError' in data) state.lastError = data.lastError ?? null;
        return { count: 1 };
      },
    },
  };
  return { db, state };
}

function build(base: string, opens: () => Promise<boolean>) {
  const { db, state } = fakeDb();
  const sent: string[] = [];
  const mailer = { enabled: true, send: async (_to: string, m: { text: string }) => void sent.push(m.text) };
  const audit = { record: async () => undefined };
  let checks = 0;
  const sender = new DecisionEmailSender(db as never, mailer as never, audit as never, base, { enabled: true, pollMs: 1000 } as never, false, true, async () => {
    checks++;
    return opens();
  });
  return { sender, state, sent, checks: () => checks };
}

describe('shortlist email: never a dead AI screening link', () => {
  it('a quick tunnel that is not running: the email waits (no link sent, no attempt used)', async () => {
    const t = build('https://dead-words-here.trycloudflare.com/screening/{token}', async () => false);
    await t.sender.tick();
    expect(t.sent).toEqual([]);
    expect(t.state.status).toBe('QUEUED');
    expect(t.state.lastError).toContain('does not open');
    expect(t.state.invites).toBe(0); // no token was made for a link nobody can open
  });

  it('the tunnel is running: the email goes out with the link', async () => {
    const t = build('https://live-words-here.trycloudflare.com/screening/{token}', async () => true);
    await t.sender.tick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain('https://live-words-here.trycloudflare.com/screening/');
    expect(t.state.status).toBe('SENT');
  });

  it('a deployed domain is trusted (not checked); local test links are not checked either', async () => {
    const t = build('https://careers.acme.com/screening/{token}', async () => false);
    await t.sender.tick();
    expect(t.checks()).toBe(0);
    expect(t.sent).toHaveLength(1);
  });

  it('knows which addresses are temporary tunnels', () => {
    expect(isTemporaryTunnel('https://postposted-plasma-gene-bridge.trycloudflare.com/screening/{token}')).toBe(true);
    expect(isTemporaryTunnel('https://abc.ngrok-free.app/screening/{token}')).toBe(true);
    expect(isTemporaryTunnel('https://careers.acme.com/screening/{token}')).toBe(false);
    expect(isTemporaryTunnel('not a url')).toBe(false);
  });
});
