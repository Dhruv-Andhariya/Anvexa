/**
 * The student's IP for the API's per-IP rate limits.
 *
 * Browsers call the API through this site (next.config.ts rewrite). Next's rewrite proxy forwards the request
 * headers as they came, and the API trusts X-Forwarded-For from this site (TRUST_PROXY=loopback). So a student
 * could send their own X-Forwarded-For and pick any "IP". middleware.ts therefore replaces it before the proxy:
 *
 *  - TRUSTED_CLIENT_IP_HEADER set (e.g. `cf-connecting-ip` behind Cloudflare / a Cloudflare tunnel, `x-real-ip`
 *    behind nginx): X-Forwarded-For = that header. `x-forwarded-for` itself means "the last entry, added by the
 *    ONE proxy in front of this site". Only correct when this site can be reached ONLY through that proxy
 *    (otherwise a visitor can send the header themselves).
 *  - not set (local dev): X-Forwarded-For is removed; the API then sees every visitor as this site's own address
 *    (one shared limit). Safe, but on a real drive set the header.
 */
export const FORWARDED_FOR = 'x-forwarded-for';

/** Loose IPv4 / IPv6 shape check: enough to refuse junk (the value is only used as a rate-limit key). */
const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:.]*)$/i;

export function trustedClientIp(headers: Headers, trustedHeader: string | undefined): string | undefined {
  const name = trustedHeader?.trim().toLowerCase();
  if (!name) return undefined;
  const raw = headers.get(name);
  if (!raw) return undefined;
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const ip = name === FORWARDED_FOR ? parts[parts.length - 1] : parts[0];
  return ip && ip.length <= 45 && IP.test(ip) ? ip : undefined;
}

/** Request headers for the API: X-Forwarded-For only from the trusted source, never as the visitor sent it. */
export function withTrustedClientIp(headers: Headers, trustedHeader: string | undefined): Headers {
  const out = new Headers(headers);
  const ip = trustedClientIp(headers, trustedHeader);
  if (ip) out.set(FORWARDED_FOR, ip);
  else out.delete(FORWARDED_FOR);
  return out;
}
