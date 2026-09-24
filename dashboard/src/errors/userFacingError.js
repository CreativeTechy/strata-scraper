import i18n from '../i18n/index.js';
import { translateApiError } from './apiError.js';

const TECHNICAL_PATTERN = /(HTTP\s*\d{3}|Traceback|stack trace|<!doctype|<html|Headers?:\s*\{|ECONN|ENOTFOUND|API[_ ]?(KEY|TOKEN)|\.env\b)/i;

function rawMessage(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input)) return input.map(rawMessage).filter(Boolean).join(' ');
  if (typeof input === 'object') {
    if (typeof input.message === 'string') return input.message.trim();
    if (typeof input.error === 'string') return input.error.trim();
    if (typeof input.detail === 'string') return input.detail.trim();
    if (Array.isArray(input.detail)) {
      return input.detail
        .map((item) => item?.msg || item?.message || rawMessage(item))
        .filter(Boolean)
        .join(' ');
    }
  }
  return '';
}

// Classifies by the stable API code when there is one, and falls back to
// matching the (English) message text for errors raised client-side or by
// endpoints that predate error codes.
function classify(code, lower) {
  const domain = code ? code.split('.')[0] : '';
  if (code === 'auth.invalid_credentials' || /invalid (username|password|credentials)|incorrect (username|password)|login failed/.test(lower)) return 'signIn';
  if (code === 'auth.not_authenticated' || code === 'auth.csrf_invalid' || code === 'http.401' || /unauthori[sz]ed|session.*(expired|invalid)|csrf|\b401\b/.test(lower)) return 'session';
  if (code === 'auth.insufficient_permissions' || code === 'http.403' || /forbidden|permission|access denied|\b403\b/.test(lower)) return 'permission';
  if ((code && /not_found$/.test(code)) || code === 'http.404' || /not found|does not exist|\b404\b/.test(lower)) return 'notFound';
  if (code === 'auth.too_many_attempts' || code === 'http.429' || /rate limit|too many requests|\b429\b/.test(lower)) return 'rateLimit';
  if (/_failed$/.test(code || '') && domain) return 'generic';
  if (code === 'http.409' || /conflict|duplicate|already exists|already in use|\b409\b/.test(lower)) return 'conflict';
  if (/timeout|timed out/.test(lower)) return 'timeout';
  if (/failed to fetch|network|connection|econn|enotfound|dns/.test(lower)) return 'network';
  if (/api[_ ]?(key|token)|credential|not configured|configuration|\.env\b/.test(lower)) return 'setup';
  if (code === 'http.400' || (code && domain !== 'internal_error' && !/^http\./.test(code)) || /required|invalid|must |at least|valid url|validation/.test(lower)) return 'validation';
  if (code === 'internal_error' || code === 'http.500' || /service unavailable|internal server|bad gateway|\b50[0234]\b/.test(lower)) return 'unavailable';
  return null;
}

// Messages built client-side with t() are already in the UI language: either
// flagged via localizedError(), or predominantly written in the active script.
// One Arabic name inside an English server error is not enough.
function isLocalized(input, raw) {
  if (input && typeof input === 'object' && input.localized) return true;
  if (typeof raw !== 'string') return false;
  if (i18n.resolvedLanguage === 'ar') {
    const arabicLetters = raw.match(/[\u0621-\u063A\u0641-\u064A\u0671-\u06D3\u06FA-\u06FF]/g)?.length || 0;
    const latinLetters = raw.match(/\p{Script=Latin}/gu)?.length || 0;
    return arabicLetters > 0 && arabicLetters >= latinLetters;
  }
  return false;
}

export function userFacingError(input, { context } = {}) {
  const t = i18n.t.bind(i18n);
  const raw = rawMessage(input);
  const lower = raw.toLowerCase();
  const code = typeof input === 'object' && input ? input.code : undefined;
  const translated = translateApiError(input);
  const technical = TECHNICAL_PATTERN.test(raw);
  const ctx = context || t('common:errors.defaultContext');
  const english = i18n.resolvedLanguage === 'en' || !i18n.resolvedLanguage;
  const localized = !english && isLocalized(input, raw);

  const result = {
    title: t('common:errors.generic.title'),
    message: t('common:errors.generic.message', { context: ctx }),
    action: t('common:errors.generic.action'),
    technicalDetail: technical ? raw : '',
  };
  const preset = (kind, extra = {}) => ({
    ...result,
    title: t(`common:errors.${kind}.title`),
    message: t(`common:errors.${kind}.message`, { context: ctx }),
    action: t(`common:errors.${kind}.action`),
    ...extra,
  });

  // Already-translated client text: the English patterns below can't classify
  // it, and it's exactly what should be shown.
  if (localized && !code && raw.length <= 400) {
    return { ...result, message: raw, technicalDetail: '' };
  }

  const kind = classify(code, lower);
  switch (kind) {
    case 'signIn':
      return preset('signIn', { technicalDetail: '' });
    case 'session':
    case 'notFound':
    case 'conflict':
    case 'rateLimit':
    case 'timeout':
    case 'network':
    case 'setup':
    case 'unavailable':
      return preset(kind);
    case 'permission':
      return preset('permission');
    case 'validation': {
      // A validation message is itself the useful part ("Password must be at
      // least 8 characters"): show the translated one, or the server's text
      // when the UI is English / no translation exists and it isn't technical.
      const message = translated || (english && !technical ? raw : '') || result.message;
      return {
        ...result,
        title: t('common:errors.validation.title'),
        message,
        action: t('common:errors.validation.action'),
        technicalDetail: (technical || (!english && raw && !translated)) ? raw : '',
      };
    }
    case 'generic':
      return { ...result, message: translated || result.message };
    default:
      break;
  }
  if (translated) return { ...result, message: translated, technicalDetail: '' };
  // Untranslated free text from the server is only shown verbatim in English;
  // in another UI language it goes under "Technical details" instead of
  // leaving an English sentence in the middle of a translated notice.
  if (raw && !technical && raw.length <= 220) {
    return english ? { ...result, message: raw, technicalDetail: '' } : { ...result, technicalDetail: raw };
  }
  return result;
}

export function friendlyRunMessage(run) {
  const t = i18n.t.bind(i18n);
  const raw = rawMessage(run?.message);
  const issueMatch = raw.match(/(\d+) source\(s\) had fetch issues/i);
  if (issueMatch) {
    return t('common:run.completeWithIssues', { count: Number(issueMatch[1]) });
  }
  if (run?.status === 'failed') return t('common:run.failed');
  if (run?.status === 'cancelled') return t('common:run.cancelled');
  if (run?.status === 'success') return t('common:run.success');
  if (run?.status === 'running') return t('common:run.running');
  const english = i18n.resolvedLanguage === 'en' || !i18n.resolvedLanguage;
  return english && raw && !TECHNICAL_PATTERN.test(raw) && raw.length <= 160 ? raw : t('common:run.waiting');
}
