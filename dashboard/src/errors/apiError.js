import i18n from '../i18n/index.js';

// Builds the Error a failed API call should throw. The backend answers every
// failure as { error, detail?, code?, params? } (see backend/api/error_codes.py):
// `error` stays the English message for compatibility, while `code`/`params`
// let the dashboard show that message in the UI language instead.
// Components throw this rather than `new Error(data.error)` so the code
// survives until ErrorNotice/userFacingError renders it.
export function apiError(payload, { status, fallback } = {}) {
  const message = payload?.error || payload?.detail || fallback
    || i18n.t('common:errors.requestFailed', { status: status ?? '?' });
  const error = new Error(typeof message === 'string' ? message : String(message));
  if (status !== undefined) error.status = status;
  if (payload?.code) error.code = payload.code;
  if (payload?.params) error.params = payload.params;
  if (payload?.detail && typeof payload.detail === 'string') error.detail = payload.detail;
  return error;
}

// Reads a failed Response's JSON body (if any) and returns the Error for it.
export async function apiErrorFromResponse(response, fallback) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Empty or non-JSON body (a 204, a proxy HTML error page).
  }
  return apiError(payload, { status: response.status, fallback });
}

// An Error whose message is already in the UI language (a client-side
// validation message built with t()). userFacingError shows it verbatim
// instead of treating it as untranslated server text.
export function localizedError(message) {
  const error = new Error(message);
  error.localized = true;
  return error;
}

// The translated message for a coded API error, or null when the code has no
// translation (an older backend, or a code added server-side first).
export function translateApiError(input) {
  const code = input?.code;
  if (!code || typeof code !== 'string') return null;
  const key = `apiErrors:${code}`;
  return i18n.exists(key) ? i18n.t(key, input.params || {}) : null;
}
