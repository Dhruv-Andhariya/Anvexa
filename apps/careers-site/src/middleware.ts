import { NextResponse, type NextRequest } from 'next/server';
import { withTrustedClientIp } from '@/lib/client-ip';

/**
 * Runs before the /api/v1/public/* rewrite to the API: sets X-Forwarded-For to the student's real IP from the
 * trusted edge header (TRUSTED_CLIENT_IP_HEADER), or removes it - never passes on what the visitor sent.
 * See lib/client-ip.ts.
 */
export function middleware(request: NextRequest) {
  return NextResponse.next({ request: { headers: withTrustedClientIp(request.headers, process.env.TRUSTED_CLIENT_IP_HEADER) } });
}

export const config = { matcher: '/api/v1/public/:path*' };
