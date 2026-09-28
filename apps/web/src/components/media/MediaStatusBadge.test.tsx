// @vitest-environment jsdom
/**
 * @file MediaStatusBadge.test.tsx
 * @description Every job status renders its translated label. A status added
 * to the union without a dictionary entry fails the type check; this asserts
 * the user-visible half — the words on screen.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MediaStatusBadge } from './MediaStatusBadge';
import { createTranslator } from '@/i18n';
import type { MediaJobStatus } from '@/lib/media-api/types';

const t = createTranslator('es');

const EXPECTED: Record<MediaJobStatus, string> = {
  queued: t('media.status.queued'),
  processing: t('media.status.processing'),
  completed: t('media.status.completed'),
  skipped: t('media.status.skipped'),
  cancelled: t('media.status.cancelled'),
  dead_lettered: t('media.status.dead_lettered'),
};

describe('MediaStatusBadge', () => {
  for (const [status, label] of Object.entries(EXPECTED) as Array<
    [MediaJobStatus, string]
  >) {
    it(`renders the translated label for ${status}`, () => {
      render(<MediaStatusBadge status={status} />);
      expect(screen.getByText(label)).toBeTruthy();
      cleanup();
    });
  }

  it('does not render a raw status identifier', () => {
    render(<MediaStatusBadge status="dead_lettered" />);
    expect(screen.queryByText('dead_lettered')).toBeNull();
    cleanup();
  });
});
