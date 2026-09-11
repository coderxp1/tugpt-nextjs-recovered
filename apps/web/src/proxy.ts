import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient as createSSRClient } from '@supabase/ssr';
import type { Database } from '@tugpt/database';

export type RouteType = 'auth' | 'protected' | 'public';

/**
 * Segment-aware prefix match: `/api/v1/drafts` matches itself and
 * `/api/v1/drafts/<id>/approve`, but NOT `/api/v1/draftsomething`.
 *
 * `startsWith` alone is wrong for an authorization decision. The old
 * `pathname.startsWith('/auth')` classified `/authorize-payments` as an auth
 * route, and the same mistake in the other direction would hand a public
 * classification to a path that merely shares a prefix with a public one.
 */
function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The paths this proxy deliberately does NOT authenticate.
 *
 * Read `public` as "the proxy is not the thing authenticating this", not as
 * "unauthenticated". Every `/api/v1` entry below authenticates itself via
 * createAuthenticatedServerClient + AuthService, with RLS behind it, and
 * returns a real 401/403 JSON body rather than an HTML redirect — which is
 * why they are not routed through the proxy's session check.
 *
 * This list is exhaustive by construction: classifyRoute denies anything not
 * on it. Adding a route without adding it here makes the route protected,
 * which is the safe direction, and proxy-route-coverage.test.ts fails until
 * somebody classifies it on purpose.
 */
const PUBLIC_EXACT: ReadonlySet<string> = new Set([
  // Redirects to /dashboard/drafts. Renders nothing and reads nothing; the
  // proxy gates the destination.
  '/',
  // Liveness probe. Returns no tenant data and is polled without credentials —
  // by the container healthcheck in docker-compose.yml, among others.
  '/api/v1/health',
]);

const PUBLIC_PREFIXES: readonly string[] = [
  // Meta calls this unauthenticated; it is gated by HMAC signature and the
  // hardcoded whatsapp_integration flag (ADR-010 amendment 2).
  '/api/v1/webhooks',
  // Handlers authenticate and resolve tenant context; RLS scopes the rows.
  '/api/v1/drafts',
  '/api/v1/organizations',
  '/api/v1/conversations',
  // Same shape: the handler authenticates, resolves the active organization,
  // and the RPC re-checks membership from the session claims before it
  // aggregates anything (20260911000001). JSON 401/403, never an HTML
  // redirect into a fetch.
  '/api/v1/analytics',
  // Same shape as the others — each handler authenticates for itself and the
  // RPCs enforce membership and role. `/api/v1/invitations/accept` is the one
  // that must be here rather than 'protected': the proxy's protected path
  // resolves an active organization, and an invitee accepting an invitation
  // has none yet for the organization they are joining. It still requires a
  // session; the handler returns 401 without one.
  '/api/v1/invitations',
];

/**
 * Deny by default.
 *
 * This used to be an allowlist of protected prefixes (`/dashboard`,
 * `/settings`, `/crm`, `/organizations`) with a `public` fallback, which fails
 * open: a page added at a path nobody remembered to add to that list was
 * served with no authentication check at all, and nothing about writing the
 * page would reveal it. The failure was silence.
 *
 * Now anything not explicitly listed above is `protected`. A forgotten route
 * is inaccessible rather than exposed, and the mistake announces itself the
 * first time somebody loads the page.
 */
export function classifyRoute(pathname: string): RouteType {
  if (underPrefix(pathname, '/auth') || underPrefix(pathname, '/api/v1/auth')) {
    return 'auth';
  }
  if (PUBLIC_EXACT.has(pathname)) {
    return 'public';
  }
  if (PUBLIC_PREFIXES.some((prefix) => underPrefix(pathname, prefix))) {
    return 'public';
  }
  return 'protected';
}

/** Is this an API path, i.e. one whose caller expects JSON rather than HTML? */
function isApiPath(pathname: string): boolean {
  return underPrefix(pathname, '/api');
}

/**
 * How a protected route refuses an unauthenticated caller.
 *
 * A browser navigating to a page should be redirected to the login form. A
 * `fetch()` for JSON should not: following a redirect to an HTML login page
 * yields a 200 with a `<!DOCTYPE html>` body, so the caller's `res.json()`
 * throws a parse error instead of seeing the 401 that actually happened. The
 * same reasoning applies to the container healthcheck, which follows redirects
 * and would report a broken app as healthy.
 *
 * Under the old fail-open classifier this branch was unreachable, because
 * every unlisted path — including every API path — was public. Deny-by-default
 * makes it reachable for any API route added without a deliberate
 * classification, which is exactly when a clear 401 matters.
 */
function denyUnauthenticated(request: NextRequest, pathname: string): NextResponse {
  if (isApiPath(pathname)) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  }
  const loginUrl = new URL('/auth/login', request.url);
  loginUrl.searchParams.set('redirect', pathname);
  return NextResponse.redirect(loginUrl);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Inject Request ID for distributed tracing
  const requestId =
    request.headers.get('x-request-id') ||
    `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  const routeType = classifyRoute(pathname);

  // Propagate tenant context from cookie or x-tenant-id header if available
  const activeTenantId =
    request.cookies.get('tugpt_tenant_id')?.value ||
    request.headers.get('x-tenant-id') ||
    undefined;

  // Handle protected routes authentication check using Supabase SSR
  if (routeType === 'protected') {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      // No Supabase env configured. This means the image was built without
      // NEXT_PUBLIC_* build args (see docker-compose.yml) and the app is
      // entirely dead — refuse rather than pretend.
      return denyUnauthenticated(request, pathname);
    }

    // Create a response that we can write refreshed cookies into
    const response = NextResponse.next({
      request: {
        headers: request.headers,
      },
    });

    const supabase = createSSRClient<Database>(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write refreshed cookies to both the request (so downstream
          // route handlers see them) and the response (so the browser
          // receives them).
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    // Use getClaims() for server-side auth verification.
    // getSession() does not revalidate the token and is not recommended
    // for server-side authorization checks per Supabase SSR guidance.
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

    if (claimsError || !claimsData) {
      return denyUnauthenticated(request, pathname);
    }

    // Propagate headers to downstream route handlers and server components
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-request-id', requestId);
    if (activeTenantId) {
      requestHeaders.set('x-tenant-id', activeTenantId);
    }

    // Update the response with our request headers
    const finalResponse = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

    // Copy any cookies that were set on the original response (from setAll)
    for (const cookie of response.cookies.getAll()) {
      finalResponse.cookies.set(cookie.name, cookie.value, cookie);
    }

    // Set response headers for client tracing
    finalResponse.headers.set('x-request-id', requestId);
    if (activeTenantId) {
      finalResponse.headers.set('x-tenant-id', activeTenantId);
    }

    return finalResponse;
  }

  // Propagate headers to downstream route handlers and server components
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);
  if (activeTenantId) {
    requestHeaders.set('x-tenant-id', activeTenantId);
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Set response headers for client tracing
  response.headers.set('x-request-id', requestId);
  if (activeTenantId) {
    response.headers.set('x-tenant-id', activeTenantId);
  }

  return response;
}

export default proxy;

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
