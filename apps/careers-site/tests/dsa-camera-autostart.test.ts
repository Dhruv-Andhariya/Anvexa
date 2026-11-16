import { describe, expect, it } from 'vitest';
import { shouldAutoStart } from '@/lib/dsa-camera';

/** The coding page turns the camera on by itself only ONCE per browser grant (no endless retry loop). */
const base = { enabled: true, permission: 'granted' as const, status: 'off' as const, problem: null, triedSinceGrant: false };

describe('camera auto-start', () => {
  it('turns the camera on by itself when the browser already allows it', () => {
    expect(shouldAutoStart(base)).toBe(true);
  });

  it('Windows blocks the camera while the browser says "granted": one try, then no loop (the page shows Try again)', () => {
    // the first automatic try failed as "denied" (NotAllowedError from the operating system)
    expect(shouldAutoStart({ ...base, status: 'error', problem: 'denied', triedSinceGrant: true })).toBe(false);
    expect(shouldAutoStart({ ...base, status: 'off', triedSinceGrant: true })).toBe(false);
  });

  it('a new grant in the browser (blocked -> allowed) allows one more automatic try', () => {
    expect(shouldAutoStart({ ...base, status: 'error', problem: 'denied', triedSinceGrant: false })).toBe(true);
  });

  it('never by itself without a grant, when switched off, while starting/on, or after other problems', () => {
    expect(shouldAutoStart({ ...base, permission: 'prompt' })).toBe(false);
    expect(shouldAutoStart({ ...base, permission: 'denied' })).toBe(false);
    expect(shouldAutoStart({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoStart({ ...base, status: 'starting' })).toBe(false);
    expect(shouldAutoStart({ ...base, status: 'on' })).toBe(false);
    expect(shouldAutoStart({ ...base, status: 'error', problem: 'in_use' })).toBe(false); // camera unplugged / busy: Try again
  });
});
