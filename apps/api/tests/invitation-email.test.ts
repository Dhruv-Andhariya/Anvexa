import { describe, expect, it } from 'vitest';
import { buildInvitationEmail } from '../src/modules/auth/invitation-email';

const LINK = 'https://hr.example/invite/abc123';
const base = { companyName: 'Acme Tech', inviterName: 'Priya Shah', role: 'HR_MEMBER' as const, link: LINK, expiresAt: new Date('2026-10-30T06:30:00Z') };

describe('buildInvitationEmail', () => {
  it('names the company, the inviter and the role, and carries the link', () => {
    const mail = buildInvitationEmail(base);
    expect(mail.subject).toBe('Join Acme Tech on ANVEXA');
    expect(mail.text).toContain('Priya Shah invited you to join Acme Tech on ANVEXA as HR Member');
    expect(mail.text).toContain(LINK);
    expect(mail.html).toContain(`href="${LINK}"`);
    expect(mail.text).toContain('30 Oct 2026');
  });

  it('works without an inviter name', () => {
    expect(buildInvitationEmail({ ...base, inviterName: null }).text).toContain('You are invited to join Acme Tech');
  });

  it('cannot inject HTML or extra header lines through names', () => {
    const mail = buildInvitationEmail({ ...base, companyName: 'Evil\r\nBcc: x@y.z', inviterName: '<script>alert(1)</script>' });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });
});
