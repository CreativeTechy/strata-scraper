import { describe, expect, it } from 'vitest';
import { resources } from '../resources.js';
import { SUPPORTED_LANGUAGES } from '../config.js';

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g;

function flatten(tree, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}

// Plural forms are compared by their base key: Arabic legitimately has
// _zero/_two/_few/_many where English only has _one/_other.
function baseKeys(flat) {
  return new Set(Object.keys(flat).map((key) => key.replace(PLURAL_SUFFIX, '')));
}

function placeholders(text) {
  return new Set([...String(text).matchAll(PLACEHOLDER)].map((match) => match[1]).filter((name) => name !== 'count'));
}

const english = resources.en;
const namespaces = Object.keys(english);
const otherLanguages = SUPPORTED_LANGUAGES.map((language) => language.code).filter((code) => code !== 'en');

describe('locale files', () => {
  it('every supported language ships every namespace', () => {
    for (const code of otherLanguages) {
      expect(Object.keys(resources[code] || {}).sort()).toEqual([...namespaces].sort());
    }
  });

  for (const ns of namespaces) {
    describe(ns, () => {
      const en = flatten(english[ns]);

      it('has no empty English strings', () => {
        const empty = Object.entries(en).filter(([, value]) => typeof value !== 'string' || !value.trim());
        expect(empty).toEqual([]);
      });

      for (const code of otherLanguages) {
        const other = flatten(resources[code]?.[ns] || {});

        it(`${code} has exactly the English keys`, () => {
          const enKeys = baseKeys(en);
          const otherKeys = baseKeys(other);
          expect([...enKeys].filter((key) => !otherKeys.has(key))).toEqual([]);
          expect([...otherKeys].filter((key) => !enKeys.has(key))).toEqual([]);
        });

        it(`${code} has no empty strings`, () => {
          const empty = Object.entries(other).filter(([, value]) => typeof value !== 'string' || !value.trim());
          expect(empty).toEqual([]);
        });

        it(`${code} uses the same placeholders as English`, () => {
          const mismatched = [];
          const enByBase = {};
          for (const [key, value] of Object.entries(en)) {
            const base = key.replace(PLURAL_SUFFIX, '');
            enByBase[base] = new Set([...(enByBase[base] || []), ...placeholders(value)]);
          }
          for (const [key, value] of Object.entries(other)) {
            const base = key.replace(PLURAL_SUFFIX, '');
            const expected = enByBase[base] || new Set();
            const actual = placeholders(value);
            const extra = [...actual].filter((name) => !expected.has(name));
            if (extra.length) mismatched.push({ key, extra });
            // Non-plural strings must keep every English placeholder too.
            if (!PLURAL_SUFFIX.test(key)) {
              const missing = [...expected].filter((name) => !actual.has(name));
              if (missing.length) mismatched.push({ key, missing });
            }
          }
          expect(mismatched).toEqual([]);
        });

        it(`${code} provides every plural form its language needs`, () => {
          const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
          const pluralBases = new Set(
            Object.keys(en).filter((key) => PLURAL_SUFFIX.test(key)).map((key) => key.replace(PLURAL_SUFFIX, '')),
          );
          const missing = [];
          for (const base of pluralBases) {
            for (const category of categories) {
              if (!(`${base}_${category}` in other)) missing.push(`${base}_${category}`);
            }
          }
          expect(missing).toEqual([]);
        });
      }
    });
  }
});
