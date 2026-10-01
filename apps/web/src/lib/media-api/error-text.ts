import type { ApiError } from './types';
import type { Translator } from '@/i18n/types';

/**
 * The sentence to show a user when a media API call fails.
 *
 * The API answers with a stable `code` plus a sanitized English `message`
 * (see `error-mapper.ts`); the browser translates the code via the
 * `errors.<CODE>` dictionary keys. The server's own sentence is the
 * fallback, which matters the day a new SQLSTATE is mapped: the user sees
 * an English explanation rather than a raw `P3M…` identifier, and
 * `dictionaries.test.ts` fails on the next run so it does not stay that
 * way.
 */
export function mediaApiErrorText(t: Translator, data: ApiError | undefined | null): string {
  const code = data?.error?.code;
  const serverMessage = data?.error?.message;
  const generic = t('errors.INTERNAL_ERROR');

  if (code) return t.maybe(`errors.${code}`, serverMessage || generic);
  return serverMessage || generic;
}
