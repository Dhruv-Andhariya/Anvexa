import { HttpStatus, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { apiError } from '../../common/api-error';
import { ACCESS_KEY, type Access, type AuthRequest } from './access';
import { SESSION_COOKIE, readCookie } from './cookies';
import { can } from './permissions';
import { SessionsService } from './sessions.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Header the dashboard sends on every write. A cross-site form cannot set it, and setting it from JS forces a CORS preflight. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'hireflow';

/**
 * Global guard (registered as APP_GUARD): every route is closed unless it declares its access with
 * @Public / @Authenticated / @PlatformAdminOnly / @RequirePermission.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      throw apiError(HttpStatus.FORBIDDEN, 'CSRF_CHECK_FAILED', 'Request blocked. Reload the page and try again.');
    }

    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!access) throw apiError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'You do not have access to this resource.'); // fail closed
    if (access.kind === 'public') return true;

    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const auth = token ? await this.sessions.resolve(token) : null;
    if (!auth) throw apiError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Please log in to continue.');
    req.auth = auth;

    switch (access.kind) {
      case 'user':
        return true;
      case 'platform':
        if (!auth.user.isPlatformAdmin) throw forbidden();
        return true;
      case 'company':
        if (!auth.company) {
          throw apiError(HttpStatus.FORBIDDEN, 'NO_COMPANY', 'Your account is not an active member of a company.');
        }
        if (auth.company.status !== 'ACTIVE') {
          throw apiError(HttpStatus.FORBIDDEN, 'COMPANY_SUSPENDED', 'This company account is suspended. Contact ANVEXA support.');
        }
        if (!can(auth.company.role, access.permission)) throw forbidden();
        return true;
    }
  }
}

const forbidden = () => apiError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'You do not have permission to do this.');
