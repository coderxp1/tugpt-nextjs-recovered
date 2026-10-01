/**
 * @file dictionaries.test.ts
 * @description The guard that keeps the dictionaries honest.
 *
 * TypeScript already refuses a dictionary with a missing or extra key, so some
 * of this looks redundant. It is not, for two reasons. `en.ts` is annotated
 * `Dictionary`, and an annotation is only load-bearing while somebody keeps it
 * — `as Dictionary`, `as any`, or a future `Partial<>` would each silence the
 * compiler and leave the app rendering `undefined` in half its buttons. And the
 * checks that actually rot are the ones the type system cannot see at all:
 * placeholders, empty strings, and whether the error codes the API can emit
 * have translations.
 *
 * The rule of thumb this file was written to: assert the things that would
 * still be true if the type annotation were deleted.
 */

import { describe, expect, it } from 'vitest';
import { ORGANIZATION_LOCALES } from '@tugpt/database';
import { es } from './es';
import { en } from './en';
import { createTranslator, formatDateTime, getDictionary } from './index';
import { knownDraftErrorCodes } from '@/lib/draft-api/error-mapper';
import { knownMediaErrorCodes } from '@/lib/media-api/error-mapper';

const dictionaries: Record<string, Record<string, string>> = { es, en };

const placeholders = (value: string): string[] =>
  (value.match(/\{(\w+)\}/g) ?? []).sort();

describe('dictionary parity', () => {
  it('every supported locale has a dictionary', () => {
    for (const locale of ORGANIZATION_LOCALES) {
      expect(Object.keys(getDictionary(locale)).length).toBeGreaterThan(0);
    }
    // And no dictionary exists for a locale the database would refuse, which
    // is the direction that produces a language nobody can be switched into.
    expect(Object.keys(dictionaries).sort()).toEqual([...ORGANIZATION_LOCALES].sort());
  });

  it('English has exactly the keys Spanish has', () => {
    // Both directions, named separately, so a failure says which mistake was
    // made rather than "sets differ".
    const spanish = Object.keys(es).sort();
    const english = Object.keys(en).sort();

    expect(english.filter((k) => !spanish.includes(k))).toEqual([]);
    expect(spanish.filter((k) => !english.includes(k))).toEqual([]);
    expect(english).toEqual(spanish);
  });

  it('no dictionary entry is empty or whitespace', () => {
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(value.trim(), `${locale}:${key} is blank`).not.toBe('');
      }
    }
  });

  it('each key uses the same placeholders in every language', () => {
    // A translation that drops `{page}` renders a sentence built around a
    // number, without the number, and reads as merely clumsy rather than
    // broken.
    for (const key of Object.keys(es) as (keyof typeof es)[]) {
      expect(placeholders(en[key]), `placeholders differ for ${key}`).toEqual(
        placeholders(es[key])
      );
    }
  });

  it('translates every error code the API can emit', () => {
    for (const code of knownDraftErrorCodes()) {
      expect(Object.keys(es), `no Spanish text for API error ${code}`).toContain(
        `errors.${code}`
      );
    }
    // The media API has its own mapper; a new P3Mxx must not ship an
    // English sentence into a Spanish dashboard unnoticed either.
    for (const code of knownMediaErrorCodes()) {
      expect(Object.keys(es), `no Spanish text for media API error ${code}`).toContain(
        `errors.${code}`
      );
    }
  });
});

describe('translator', () => {
  it('returns the dictionary string for the requested locale', () => {
    expect(createTranslator('es')('drafts.actions.approve')).toBe('Aprobar');
    expect(createTranslator('en')('drafts.actions.approve')).toBe('Approve');
  });

  it('substitutes placeholders', () => {
    expect(createTranslator('es')('drafts.inbox.pagination', { page: 2, pages: 5 })).toBe(
      'Página 2 de 5'
    );
  });

  it('leaves an unsupplied placeholder visible rather than dropping it', () => {
    // Documented behaviour, not an accident: a visible `{pages}` on screen is
    // a bug report. `Página 2 de ` is a spacing complaint.
    expect(createTranslator('es')('drafts.inbox.pagination', { page: 2 })).toBe(
      'Página 2 de {pages}'
    );
  });

  it('falls back to the given text for a key it does not have', () => {
    const t = createTranslator('es');
    expect(t.maybe('errors.SOMETHING_NEW', 'Server said this')).toBe('Server said this');
    expect(t.maybe('errors.FORBIDDEN', 'Server said this')).toBe(
      es['errors.FORBIDDEN']
    );
  });

  it('carries its locale', () => {
    expect(createTranslator('en').locale).toBe('en');
  });
});

describe('formatDateTime', () => {
  it('formats in the requested locale', () => {
    const es_ = formatDateTime('2026-08-30T14:05:00Z', 'es');
    const en_ = formatDateTime('2026-08-30T14:05:00Z', 'en');
    expect(es_).not.toBe('');
    expect(en_).not.toBe('');
    // Both render the same instant; the point is only that the tag reaches
    // Intl, which shows up as a different arrangement of the same numbers.
    expect(es_).not.toBe(en_);
  });

  it('returns an unparseable value untouched', () => {
    expect(formatDateTime('not a date', 'es')).toBe('not a date');
  });
});
