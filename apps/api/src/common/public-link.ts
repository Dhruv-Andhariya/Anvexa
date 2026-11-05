/**
 * Links emailed to students (AI screening, AI interview...) start with the careers site's public address. On this
 * project that is often a Cloudflare quick tunnel (or ngrok), which gets a NEW address on every restart; the old one
 * stops existing. These helpers let a module check, before emailing, that a temporary tunnel link still opens.
 */

/** A temporary tunnel address: it stops existing when the tunnel stops or restarts. A deployed domain is not one. */
export const isTemporaryTunnel = (base: string): boolean => {
  try {
    const host = new URL(base.replace('{token}', 'x')).hostname.toLowerCase();
    return ['.trycloudflare.com', '.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io'].some((d) => host.endsWith(d));
  } catch {
    return false;
  }
};

/** Injection token for tests: whether the site behind a link answers. */
export const LINK_STILL_OPENS = Symbol('LINK_STILL_OPENS');

/** The site behind a link still answers (a replaced Cloudflare quick tunnel does not even resolve any more). */
export const linkStillOpens = async (base: string): Promise<boolean> => {
  try {
    const res = await fetch(new URL(base.replace('{token}', 'x')).origin, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    return res.status < 400;
  } catch {
    return false;
  }
};

/** How long a "the current link opens" answer is reused before the site is asked again. */
export const LINK_CHECK_CACHE_MS = 60_000;

/**
 * Remembers whether the CURRENT link base opens (temporary tunnels only; anything else is trusted), asking at most
 * once a minute. Used right before an email with a link is sent: a dead tunnel link is never emailed.
 */
export class CurrentLinkCheck {
  private last: { at: number; opens: Promise<boolean> } | null = null;

  constructor(private readonly stillOpens: (base: string) => Promise<boolean> = linkStillOpens) {}

  async opens(base: string | null): Promise<boolean> {
    if (!base || !isTemporaryTunnel(base)) return true;
    if (!this.last || Date.now() - this.last.at > LINK_CHECK_CACHE_MS) {
      this.last = { at: Date.now(), opens: this.stillOpens(base).catch(() => false) };
    }
    return this.last.opens;
  }
}
