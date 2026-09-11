import type { MessageKey } from '@/i18n/types';

export interface NavItem {
  /** Route this links to. Must be a real page route. */
  readonly href: string;
  /** Dictionary key for the label. Typed, so a missing translation will not compile. */
  readonly labelKey: MessageKey;
}

/**
 * The primary navigation, in the order a reviewer reads it.
 *
 * Exported as data rather than written inline in the nav component because
 * `tests/app-routes-reachable.test.ts` checks it against the app directory:
 * the Sep 11 milestone is "every page reachable without typing a URL", and a
 * page added without a way to get to it should fail a test rather than wait
 * for somebody to notice they cannot find it.
 *
 * The thread view (Sep 18) added no entry — it lives inside a draft. The
 * unified inbox (Sep 25) is here, and first: it answers "who is waiting",
 * which is the question a reviewer arrives with, while the draft list answers
 * "what did the AI write" about the subset that already has a draft.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard/inbox', labelKey: 'nav.inbox' },
  { href: '/dashboard/drafts', labelKey: 'nav.drafts' },
  // Last, and deliberately: the inbox answers "who is waiting" and the drafts
  // answer "what did the AI write" — both are the reviewer's job. Usage & cost
  // answers "what is this costing", which is the owner's question, and it is
  // the one a reviewer opens least.
  { href: '/dashboard/analytics', labelKey: 'nav.analytics' },
];

/**
 * Is `pathname` inside this nav item's section?
 *
 * A draft's detail page is still "Borradores" as far as the reviewer is
 * concerned, so the inbox link stays marked while they read one. Matching on
 * segment boundaries rather than `startsWith` for the same reason `proxy.ts`
 * does: `/dashboard/draftsomething` is not `/dashboard/drafts`.
 */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
