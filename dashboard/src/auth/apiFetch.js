import i18n from '../i18n/index.js';

const CSRF_COOKIE_NAME = 'strata_csrf';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function isSameOriginApiRequest(input) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.startsWith('/api') || url.startsWith('/scrape')) return true;
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function apiRequestHeaders(input, init = {}, method = 'GET', csrfToken = '') {
  const headers = new Headers(
    init.headers || (typeof input !== 'string' ? input?.headers : undefined),
  );
  headers.set('Accept-Language', i18n.resolvedLanguage || i18n.language || 'en');
  if (csrfToken && UNSAFE_METHODS.has(method.toUpperCase())) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  return headers;
}

// Installs a one-time wrapper around window.fetch so every existing fetch()
// call site in the dashboard gets CSRF-protected mutations and a global
// 401 -> "you were logged out" signal, without editing each call site.
export function installApiInterceptor() {
  if (window.__strataFetchPatched) return;
  window.__strataFetchPatched = true;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const method = (init.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();

    let nextInit = init;
    if (isSameOriginApiRequest(input)) {
      const csrfToken = readCookie(CSRF_COOKIE_NAME);
      nextInit = { ...init, headers: apiRequestHeaders(input, init, method, csrfToken) };
    }

    const response = await nativeFetch(input, nextInit);
    if (response.status === 401 && isSameOriginApiRequest(input)) {
      window.dispatchEvent(new CustomEvent('strata:unauthorized'));
    }
    return response;
  };
}
