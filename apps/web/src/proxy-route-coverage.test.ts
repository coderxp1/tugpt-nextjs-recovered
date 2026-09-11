/**
 * classifyRoute() in proxy.ts used to be an allowlist of protected prefixes
 * with a public fallback:
 *
 *   if (/auth ...)        -> 'auth'
 *   if (/dashboard | /settings | /crm | /organizations) -> 'protected'
 *   return 'public'
 *
 * That failed open. A page added at a path nobody remembered to add to the
 * protected list was served by the proxy with no authentication check at all,
 * and nothing about writing that page would reveal it — the failure was
 * silence.
 *
 * As of 2026-08-24 it is inverted: anything not explicitly listed as `auth` or
 * `public` is `protected`. This file was written first, because inverting the
 * default is only safe once the full public surface is enumerated and each
 * entry has a recorded reason — and that is what the table below is.
 *
 * Both halves still earn their place, and they catch opposite mistakes:
 *
 *   - Deny-by-default stops an unlisted route from being *exposed*.
 *   - This table stops a route from being classified *silently*, either way.
 *     Under deny-by-default a forgotten route is unreachable rather than
 *     leaked, and unreachable is also a bug — one that now fails here rather
 *     than in production.
 *
 * The route table must match the app directory exactly, so a new route fails
 * the suite until somebody classifies it on purpose and records why. The last
 * test is the one with teeth: it fails the moment a page outside /auth becomes
 * reachable without an authentication check.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { classifyRoute, type RouteType } from './proxy';
import { APP_DIR, discoverRoutes, type RouteKind } from '../tests/support/app-routes';

interface RouteExpectation {
  path: string;
  kind: RouteKind;
  type: RouteType;
  /** Why this classification is correct. Required, especially for 'public'. */
  why: string;
}

const ROUTES: RouteExpectation[] = [
  {
    path: '/',
    kind: 'page',
    type: 'public',
    // This reason used to read "Landing page. Renders no tenant data." True,
    // and useless: `/` was create-next-app boilerplate the entire time, and a
    // reason written about tenant data could never catch that. It now
    // redirects to the conversation inbox and renders nothing at all.
    why: 'Redirects to /dashboard/inbox. Renders nothing and reads nothing; the proxy gates the destination.',
  },
  {
    path: '/auth/login',
    kind: 'page',
    type: 'auth',
    why: 'Sign-in. Must be reachable while signed out.',
  },
  {
    path: '/auth/callback',
    kind: 'page',
    type: 'auth',
    why: 'OAuth/magic-link return leg. Runs before a session exists.',
  },
  {
    path: '/auth/logout',
    kind: 'page',
    type: 'auth',
    why: 'Clears the session; must not redirect to login on the way out.',
  },
  {
    path: '/dashboard/inbox',
    kind: 'page',
    type: 'protected',
    why: 'Unified conversation inbox. The proxy is the only gate on the page shell.',
  },
  {
    path: '/dashboard/drafts',
    kind: 'page',
    type: 'protected',
    why: 'Draft list. The proxy is the only gate on the page shell.',
  },
  // No entry for /dashboard itself: `dashboard/layout.tsx` wraps the pages
  // below it and has no URL of its own. If a `dashboard/page.tsx` is ever
  // added, the discovery test below fails until it is classified here.
  {
    path: '/dashboard/drafts/[draftId]',
    kind: 'page',
    type: 'protected',
    why: 'Draft detail. The proxy is the only gate on the page shell.',
  },
  {
    path: '/dashboard/analytics',
    kind: 'page',
    type: 'protected',
    why: 'Usage & cost report. The proxy is the only gate on the page shell; the data itself comes from a membership-checked RPC.',
  },

  // Every /api/v1 route below is 'public' to the proxy on purpose: the proxy
  // performs no authentication for them, and each handler authenticates for
  // itself via createAuthenticatedServerClient + AuthService, with RLS behind
  // it. Do not read 'public' here as "unauthenticated" — read it as "the proxy
  // is not the thing authenticating this".
  {
    path: '/api/v1/auth/session',
    kind: 'api',
    type: 'auth',
    why: 'Session probe. Answers "am I signed in", so it must run signed out.',
  },
  {
    path: '/api/v1/health',
    kind: 'api',
    type: 'public',
    why: 'Liveness probe. Returns no tenant data and is polled without credentials.',
  },
  {
    path: '/api/v1/webhooks/whatsapp',
    kind: 'api',
    type: 'public',
    why: 'Meta calls this unauthenticated; it is gated by HMAC signature and the hardcoded whatsapp_integration flag (ADR-010 amendment 2).',
  },
  {
    path: '/api/v1/organizations',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates: 401 without a user, 403 on an x-tenant-id the user does not belong to.',
  },
  {
    path: '/api/v1/drafts',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant context; RLS scopes the rows.',
  },
  {
    path: '/api/v1/drafts/[draftId]',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant context; RLS scopes the row.',
  },
  {
    path: '/api/v1/drafts/[draftId]/approve',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; the RPC enforces role and raises P3B02 otherwise.',
  },
  {
    path: '/api/v1/drafts/[draftId]/edit',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; the RPC enforces role and raises P3B02 otherwise.',
  },
  {
    path: '/api/v1/drafts/[draftId]/reject',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; the RPC enforces role and raises P3B02 otherwise.',
  },
  {
    path: '/api/v1/drafts/[draftId]/events',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; RLS scopes review events to the draft owner org.',
  },
  {
    path: '/api/v1/drafts/[draftId]/thread',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates, resolves tenant, and passes the feature gate before ' +
      'reading; RLS scopes messages to the org and the query scopes them to the ' +
      'conversation. Returns more customer text than any other route, so its ' +
      'serialised response shape is asserted field-by-field in thread-route.test.ts.',
  },
  {
    path: '/api/v1/conversations',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates, resolves tenant, and passes the same feature gate as the ' +
      'draft routes before reading; every query is scoped by organization_id and RLS ' +
      'scopes conversations to org members. Returns masked contacts and no message text ' +
      'at all, asserted in conversations-route.test.ts.',
  },
  {
    path: '/api/v1/analytics/usage',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates and resolves tenant; the org_usage_summary RPC re-checks ' +
      'membership from the session claims (auth.uid()) inside the definer and returns an ' +
      'aggregate only — no per-row usage, no customer identifiers. provider_usage_events ' +
      'stays service_role-only; this is a read path over an aggregate, asserted in ' +
      'analytics-usage-route.test.ts.',
  },
  {
    path: '/api/v1/conversations/[conversationId]/assign',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates, resolves tenant, and passes the feature gate; it then ' +
      'delegates every authorization decision to assign_conversation, which derives the ' +
      'organization from the locked row and raises P3C01/P3C02/P3C03 rather than trusting ' +
      'anything the caller sent. Asserted in assignment-routes.test.ts.',
  },
  {
    path: '/api/v1/conversations/[conversationId]/handoff',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates, resolves tenant, and passes the feature gate; the RPC owns ' +
      'membership, role, and the legal transitions. This is the switch that stops AI ' +
      'drafting for one customer, so the proxy classification being deliberate matters ' +
      'more here than anywhere else: it is public to the proxy and authenticated twice ' +
      'behind it. Asserted in assignment-routes.test.ts.',
  },
  {
    path: '/api/v1/invitations',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates and resolves tenant; create_invitation derives the ' +
      'organization from the caller\'s membership row and enforces role, rank and ' +
      'uniqueness. POST returns the one-time invitation token, which is why its ' +
      'logging is asserted field-by-field in invitation-routes.test.ts.',
  },
  {
    path: '/api/v1/invitations/[invitationId]/revoke',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates; revoke_invitation owns membership and role, and ' +
      'answers P3D01 for another tenant\'s invitation so ids cannot be probed.',
  },
  {
    path: '/api/v1/invitations/accept',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates but deliberately resolves NO tenant: the caller is ' +
      'joining an organization they are not yet a member of, so the token carries ' +
      'the tenant and the RPC reads it from the locked row. The only route where ' +
      'the body rather than the session names the organization, which is why the ' +
      'token is a 244-bit server-generated secret.',
  },
  {
    path: '/api/v1/drafts/[draftId]/revisions',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; RLS scopes revisions to the draft owner org.',
  },
];

describe('proxy route classification coverage', () => {
  it('finds the app router directory (guards against a cwd change breaking these tests silently)', () => {
    expect(existsSync(APP_DIR)).toBe(true);
    expect(discoverRoutes(APP_DIR).length).toBeGreaterThan(0);
  });

  it('lists every routable path in the app directory, and no path that does not exist', () => {
    const discovered = discoverRoutes(APP_DIR)
      .map((r) => r.path)
      .sort();
    const expected = ROUTES.map((r) => r.path).sort();

    // A failure here means a route was added or removed. Add it to ROUTES with
    // a deliberate classification and a reason — do not delete this assertion.
    expect(discovered).toEqual(expected);
  });

  it('classifies each route the way the table says', () => {
    for (const route of ROUTES) {
      expect(classifyRoute(route.path), `${route.path} — ${route.why}`).toBe(route.type);
    }
  });

  it('records a reason for every route the proxy does not authenticate', () => {
    for (const route of ROUTES.filter((r) => r.type === 'public')) {
      expect(route.why.length, `${route.path} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('leaves no page outside /auth reachable without an authentication check', () => {
    const unguarded = ROUTES.filter((r) => r.kind === 'page' && classifyRoute(r.path) === 'public').map(
      (r) => r.path
    );

    // The landing page is the only one, and it renders no tenant data. If this
    // list grows, a page is being served to anyone who asks for it.
    expect(unguarded).toEqual(['/']);
  });

  it('matches the app directory on kind as well as path', () => {
    const discovered = new Map(discoverRoutes(APP_DIR).map((r) => [r.path, r.kind]));
    for (const route of ROUTES) {
      expect(discovered.get(route.path), `${route.path} kind`).toBe(route.kind);
    }
  });
});
