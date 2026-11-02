import { SetMetadata } from '@nestjs/common';
import type { SessionCompany } from '@hireflow/contracts';
import type { Permission } from './permissions';

/** What AuthGuard attaches to the request after it validated the session cookie. */
export interface AuthInfo {
  sessionId: string;
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  /** the session's company, only if the user still has an ACTIVE membership in it */
  company: SessionCompany | null;
}

/** The parts of the HTTP request the auth code reads (keeps us independent of express typings). */
export interface AuthRequest {
  method: string;
  ip?: string;
  /** true for HTTPS (Express; honours X-Forwarded-Proto from proxies trusted by TRUST_PROXY) */
  secure?: boolean;
  headers: Record<string, string | string[] | undefined>;
  auth?: AuthInfo;
}

export type Access =
  | { kind: 'public' }
  | { kind: 'user' } // any logged-in user, with or without a company
  | { kind: 'platform' }
  | { kind: 'company'; permission: Permission };

export const ACCESS_KEY = 'hireflow:access';

/** No session needed (login, invitation links, health). */
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies Access);
/** Any logged-in user (e.g. /auth/me). */
export const Authenticated = () => SetMetadata(ACCESS_KEY, { kind: 'user' } satisfies Access);
/** Platform Admin only. */
export const PlatformAdminOnly = () => SetMetadata(ACCESS_KEY, { kind: 'platform' } satisfies Access);
/** A member of an ACTIVE company whose role has `permission` (see PERMISSIONS). */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(ACCESS_KEY, { kind: 'company', permission } satisfies Access);
