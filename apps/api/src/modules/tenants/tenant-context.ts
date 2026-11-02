import { HttpStatus, Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { apiError } from '../../common/api-error';
import type { AuthRequest } from '../auth';

/** The logged-in user acting on the company's data (stored as created_by / approved_by). */
export interface Actor {
  id: string;
  name: string;
}

/** Answers "which company is this request for, and who is acting?". Every tenant-owned query is scoped by this id. */
export abstract class TenantContext {
  abstract currentTenantId(): Promise<string>;
  abstract currentActor(): Promise<Actor>;
}

/**
 * The company comes ONLY from the session that AuthGuard verified for this request (an ACTIVE membership in an
 * ACTIVE company). A company id in a URL, header or body is never trusted.
 */
@Injectable({ scope: Scope.REQUEST })
export class RequestTenantContext extends TenantContext {
  constructor(@Inject(REQUEST) private readonly req: AuthRequest) {
    super();
  }

  async currentTenantId(): Promise<string> {
    const company = this.req.auth?.company;
    // AuthGuard already rejects these; this is defence in depth for a route that forgot @RequirePermission
    if (!company || company.status !== 'ACTIVE') {
      throw apiError(HttpStatus.FORBIDDEN, 'NO_COMPANY', 'Your account is not an active member of a company.');
    }
    return company.id;
  }

  async currentActor(): Promise<Actor> {
    const user = this.req.auth?.user;
    if (!user) throw apiError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Please log in to continue.');
    return { id: user.id, name: user.name };
  }
}
