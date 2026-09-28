/**
 * @file app-routes-reachable.test.ts
 * @description "Every page reachable without typing a URL" — the Sep 11
 * milestone's own wording, turned into something that fails.
 *
 * WHY THIS EXISTS
 *
 * Until 2026-08-31 the app had no navigation at all. `/dashboard/drafts`
 * rendered a bare heading; `/auth/logout` existed, worked, and could be
 * reached only by typing it into the address bar. Nothing was broken in a way
 * any test could see, because "there is no way to get here" is not a defect
 * any *page* has — it is a defect in the space between pages, which is exactly
 * the kind nobody notices until a reviewer asks how to sign out.
 *
 * `proxy-route-coverage.test.ts` already asks whether every route is
 * *classified* on purpose. This asks the other half: whether every route can
 * be *arrived at* on purpose. A page can be perfectly authenticated and still
 * be unreachable, and under deny-by-default an unreachable page is the
 * likelier failure of the two.
 *
 * HOW IT DECIDES
 *
 * A page is reachable if the primary navigation links to it, or if REACHED_BY
 * below names the thing that does. The second list is not an escape hatch: a
 * dynamic route has no fixed URL to put in a nav, and a login page is arrived
 * at by being bounced there. Each entry has to say what links to it, and a
 * reason too short to name anything fails T4 — the same rule
 * `proxy-route-coverage.test.ts` applies to its `why` strings, and for the
 * same reason. "n/a" is how a table like this stops meaning anything.
 *
 * API routes are out of scope. They are called by code, not navigated to.
 */

import { describe, expect, it } from 'vitest';
import { APP_DIR, discoverRoutes } from './support/app-routes';
import { NAV_ITEMS, isActive } from '../src/components/shell/nav-items';

/** Pages that are arrived at some way other than the primary navigation. */
const REACHED_BY: ReadonlyArray<{ path: string; by: string }> = [
  {
    path: '/',
    by: 'Whatever a person types or bookmarks for the bare domain. It redirects to /dashboard/inbox and renders nothing.',
  },
  {
    path: '/auth/login',
    by: 'The proxy redirects here, with ?redirect=, whenever a signed-out visitor opens a protected page.',
  },
  {
    path: '/auth/callback',
    by: 'The identity provider returns the browser here after an OAuth or magic-link round trip. Never linked from inside the app.',
  },
  {
    path: '/auth/logout',
    by: 'The sign-out control in the app shell header (AppShell.tsx), asserted in AppShell.test.tsx.',
  },
  {
    path: '/dashboard/drafts/[draftId]',
    by: 'Every row of the draft list links to one (DraftInbox.test.tsx), as does every conversation with a draft waiting (ConversationInbox.test.tsx). A dynamic route has no single URL to navigate to.',
  },
  {
    path: '/dashboard/media/new',
    by: 'The "Nuevo trabajo" button on the media job list (MediaJobList.tsx) opens the submission form; it is a step in the list flow, not a destination of its own.',
  },
  {
    path: '/dashboard/media/[jobId]',
    by: 'Every row of the media job list links to one (MediaJobList.test.tsx). A dynamic route has no single URL to navigate to.',
  },
];

const pageRoutes = discoverRoutes(APP_DIR)
  .filter((r) => r.kind === 'page')
  .map((r) => r.path)
  .sort();

const navHrefs = NAV_ITEMS.map((i) => i.href);

describe('every page can be reached without typing a URL', () => {
  it('T1: found some pages to check (a broken walker must not pass silently)', () => {
    expect(pageRoutes.length).toBeGreaterThan(0);
  });

  it('T2: every page is either in the navigation or accounted for', () => {
    const accounted = new Set([...navHrefs, ...REACHED_BY.map((r) => r.path)]);
    const orphans = pageRoutes.filter((p) => !accounted.has(p));

    // A failure here means a page was added with no way to get to it. Link it
    // from the navigation, or add it to REACHED_BY naming what does.
    expect(orphans, 'pages nothing links to').toEqual([]);
  });

  it('T3: the navigation does not point at pages that do not exist', () => {
    // The opposite mistake, and the one a rename makes: a nav item surviving
    // the route it named, so the only visible symptom is a 404 on click.
    const missing = navHrefs.filter((href) => !pageRoutes.includes(href));
    expect(missing, 'navigation entries with no page behind them').toEqual([]);
  });

  it('T4: every REACHED_BY entry names what links to it', () => {
    for (const entry of REACHED_BY) {
      expect(entry.by.length, `${entry.path} needs a real reason`).toBeGreaterThan(30);
    }
  });

  it('T5: REACHED_BY lists no page that does not exist', () => {
    // Without this the table rots in the quiet direction: a deleted page keeps
    // its excuse forever, and the excuse is what a reader trusts.
    const stale = REACHED_BY.map((r) => r.path).filter((p) => !pageRoutes.includes(p));
    expect(stale, 'REACHED_BY entries for pages that are gone').toEqual([]);
  });

  it('T6: nothing is both navigated to and excused', () => {
    const both = navHrefs.filter((h) => REACHED_BY.some((r) => r.path === h));
    expect(both, 'pages listed in the navigation AND in REACHED_BY').toEqual([]);
  });
});

describe('active-section matching', () => {
  it('marks the inbox while a draft under it is open', () => {
    // The reviewer opening a draft has not left Borradores, and a nav that
    // un-highlights itself the moment you use it is worse than no highlight.
    expect(isActive('/dashboard/drafts/abc-123', '/dashboard/drafts')).toBe(true);
    expect(isActive('/dashboard/drafts', '/dashboard/drafts')).toBe(true);
  });

  it('does not match a path that merely shares a prefix', () => {
    // Same failure `proxy.ts` documents for `startsWith('/auth')` classifying
    // `/authorize-payments`. Cosmetic here, structural there; one rule.
    expect(isActive('/dashboard/draftsomething', '/dashboard/drafts')).toBe(false);
  });
});
