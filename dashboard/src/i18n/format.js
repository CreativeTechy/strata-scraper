// The one place dates, numbers, and language/country names are formatted for
// display. Everything reads the active UI language at call time, so a
// component that re-renders on language change (any useTranslation() user)
// picks up the new locale without extra wiring.
import i18n from './index.js';
import { DEFAULT_LANGUAGE, findLanguage } from './config.js';

export function intlLocale(code = i18n.language) {
  return (findLanguage(code) || findLanguage(DEFAULT_LANGUAGE)).intlLocale;
}

export function isRtl(code = i18n.language) {
  return (findLanguage(code) || findLanguage(DEFAULT_LANGUAGE)).dir === 'rtl';
}

export function generatedTextDirection(code) {
  const language = findLanguage(code);
  return language ? language.dir : 'auto';
}

export function generatedLanguageNeedsRefresh(record, currentLanguage = i18n.language) {
  if (!record) return false;
  const generated = findLanguage(record.generated_language)?.code;
  const current = findLanguage(currentLanguage)?.code || DEFAULT_LANGUAGE;
  const knownGeneratedContent = Boolean(record.analysis_model || record.discovery_source === 'ai');
  return knownGeneratedContent && (!generated || generated !== current);
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatNumber(value, options) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value === null || value === undefined ? '' : String(value);
  return new Intl.NumberFormat(intlLocale(), options).format(number);
}

export function formatPercent(value, options = { maximumFractionDigits: 0 }) {
  return formatNumber(value, { style: 'percent', ...options });
}

// `fallback` is returned for missing/unparseable input; pass the raw value
// when the caller would rather show what it got than nothing.
export function formatDate(value, options = { year: 'numeric', month: 'short', day: 'numeric' }, fallback = '') {
  const date = toDate(value);
  return date ? date.toLocaleDateString(intlLocale(), options) : fallback;
}

export function formatDateTime(
  value,
  options = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  fallback = '',
) {
  const date = toDate(value);
  return date ? date.toLocaleString(intlLocale(), options) : fallback;
}

export function formatTime(value, options = { hour: '2-digit', minute: '2-digit' }, fallback = '') {
  const date = toDate(value);
  return date ? date.toLocaleTimeString(intlLocale(), options) : fallback;
}

const RELATIVE_STEPS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

// "3 minutes ago" / "منذ 3 دقائق"; anything under a minute reads as "now".
export function formatRelativeTime(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return '';
  const seconds = Math.round((date.getTime() - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' });
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.trunc(seconds / size), unit);
  }
  return formatter.format(0, 'second');
}

// Elapsed-time label for durations (run times, timeouts), e.g. "2 min, 5 sec".
export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts = [];
  const unit = (amount, name) => new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: name, unitDisplay: 'short' }).format(amount);
  if (hours) parts.push(unit(hours, 'hour'));
  if (minutes) parts.push(unit(minutes, 'minute'));
  if (secs || !parts.length) parts.push(unit(secs, 'second'));
  return new Intl.ListFormat(intlLocale(), { style: 'narrow', type: 'unit' }).format(parts);
}

function displayName(type, code, fallback) {
  if (!code) return fallback ?? '';
  try {
    const name = new Intl.DisplayNames([intlLocale()], { type, fallback: 'none' }).of(code);
    if (name) return name;
  } catch {
    // Unknown/invalid code (e.g. "und", free text): fall through.
  }
  return fallback ?? code;
}

// Article language codes come from the detector as ISO 639 codes ("en", "ar").
export function languageName(code, fallback) {
  return displayName('language', String(code || '').trim(), fallback);
}

// ISO 3166-1 alpha-2 country code -> name in the UI language.
export function countryName(code, fallback) {
  return displayName('region', String(code || '').trim().toUpperCase(), fallback);
}

export function formatList(items, type = 'conjunction') {
  return new Intl.ListFormat(intlLocale(), { style: 'long', type }).format(items.map(String));
}
