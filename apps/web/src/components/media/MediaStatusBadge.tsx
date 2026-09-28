import { useT } from '@/i18n/provider';
import type { MediaJobStatus } from '@/lib/media-api/types';

/**
 * Status pill for a media job. Every status is a dictionary key — the
 * compiler proves all six exist — never a capitalized database string.
 */
export function MediaStatusBadge({ status }: { status: MediaJobStatus }) {
  const t = useT();
  const styles: Record<MediaJobStatus, string> = {
    queued: 'bg-yellow-100 text-yellow-800',
    processing: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    skipped: 'bg-zinc-100 text-zinc-600',
    cancelled: 'bg-zinc-200 text-zinc-700',
    dead_lettered: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`rounded-full px-2 py-1 text-xs font-medium ${styles[status]}`}>
      {t(`media.status.${status}`)}
    </span>
  );
}
