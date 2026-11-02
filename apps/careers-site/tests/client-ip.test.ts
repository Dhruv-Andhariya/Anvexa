import { describe, expect, it } from 'vitest';
import { CONTENT } from '../src/content';
import { trustedClientIp, withTrustedClientIp } from '../src/lib/client-ip';

const h = (init: Record<string, string>) => new Headers(init);

describe('client IP for the API rate limits', () => {
  it('without a trusted header, drops whatever X-Forwarded-For the visitor sent', () => {
    const out = withTrustedClientIp(h({ 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '7.7.7.7', 'x-requested-with': 'hireflow' }), undefined);
    expect(out.get('x-forwarded-for')).toBeNull();
    expect(out.get('x-requested-with')).toBe('hireflow'); // other headers untouched
    expect(withTrustedClientIp(h({ 'x-forwarded-for': '6.6.6.6' }), '  ').get('x-forwarded-for')).toBeNull();
  });

  it('behind Cloudflare: X-Forwarded-For becomes cf-connecting-ip, replacing a forged one', () => {
    const out = withTrustedClientIp(h({ 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '49.36.10.20' }), 'CF-Connecting-IP');
    expect(out.get('x-forwarded-for')).toBe('49.36.10.20');
    expect(trustedClientIp(h({ 'cf-connecting-ip': '2409:40c1:10::1' }), 'cf-connecting-ip')).toBe('2409:40c1:10::1');
  });

  it('trusted header missing or junk: X-Forwarded-For is removed (never the visitor-sent value)', () => {
    expect(withTrustedClientIp(h({ 'x-forwarded-for': '6.6.6.6' }), 'cf-connecting-ip').get('x-forwarded-for')).toBeNull();
    expect(withTrustedClientIp(h({ 'cf-connecting-ip': 'not-an-ip' }), 'cf-connecting-ip').get('x-forwarded-for')).toBeNull();
  });

  it('x-forwarded-for as the trusted header takes the LAST entry (added by the one proxy in front)', () => {
    expect(trustedClientIp(h({ 'x-forwarded-for': '6.6.6.6, 49.36.10.20' }), 'x-forwarded-for')).toBe('49.36.10.20');
  });
});

describe('confirmation email wording', () => {
  it('does not claim the email was already sent (it is only queued)', () => {
    const text = CONTENT.form.success.emailSent('asha@example.com');
    expect(text).toContain('asha@example.com');
    expect(text).not.toMatch(/on its way|has been sent|we sent/i);
  });
});
