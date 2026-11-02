import { existsSync } from 'node:fs';
import path from 'node:path';

/** Load <repo root>/.env once at startup (like the AI worker). Real environment variables always win. */
export function loadRootEnv(start = __dirname): string | undefined {
  let dir = path.resolve(start);
  while (true) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      const file = path.join(dir, '.env');
      if (!existsSync(file)) return undefined;
      process.loadEnvFile(file);
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * TRUST_PROXY as Express "trust proxy": which proxies may set X-Forwarded-For, so req.ip is the real visitor
 * (per-IP rate limits, CAPTCHA). Default "loopback": the careers site (Next.js rewrite + its middleware, which
 * rewrites X-Forwarded-For) and a local tunnel call the API from this machine. Behind a load balancer use its hop
 * count ("1") or subnet; "false" turns it off. "true" trusts every hop (only when nothing can reach the API directly).
 * Booleans and numbers are converted: Express would read the string "true" as an IP address and fail at startup.
 */
export function trustProxySetting(raw: string | undefined): boolean | number | string {
  const value = raw?.trim() || 'loopback';
  if (value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}
