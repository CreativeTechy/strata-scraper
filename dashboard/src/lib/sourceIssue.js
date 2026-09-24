import i18n from '../i18n/index.js';

// Display text for a per-source fetch issue. The backend's
// classify_fetch_issue (backend/services/pipeline/source_diagnostics.py)
// returns { code, title, message, action, severity, technical_detail } with
// the title/message/action as English text; `code` is the stable part, so the
// UI translates from it. A few codes have more than one English wording
// (e.g. "LinkedIn setup required" vs "Search setup required"), told apart by
// the title the backend chose. An unknown code keeps the backend's own text
// (flagged `untranslated` so callers can mark it dir="auto").
// Called during render only - reads the active language at call time.

const CODE_KEYS = {
  invalid_source: 'invalidSource',
  rate_limited: 'rateLimited',
  access_blocked: 'accessBlocked',
  authentication_failed: 'authenticationFailed',
  service_unavailable: 'serviceUnavailable',
  timed_out: 'timedOut',
  connection_failed: 'connectionFailed',
  source_unavailable: 'sourceUnavailable',
  no_results: 'noResults',
  http_error: 'httpError',
  fetch_failed: 'fetchFailed',
};

function issueKey(issue) {
  const code = String(issue?.code || '');
  const title = String(issue?.title || '');
  if (code === 'setup_required') {
    if (/^linkedin\b/i.test(title)) return 'setupLinkedin';
    if (/^x search\b/i.test(title)) return 'setupXSearch';
    if (/^search\b/i.test(title) || /search integration/i.test(issue?.message || '')) return 'setupSearch';
    return 'setupIntegration';
  }
  if (code === 'not_found') return /^x account\b/i.test(title) ? 'notFoundX' : 'notFound';
  return CODE_KEYS[code] || null;
}

function httpStatusFrom(text) {
  const match = String(text || '').match(/HTTP\s*(\d{3})/i);
  return match ? match[1] : '?';
}

export function translateSourceIssue(issue) {
  if (!issue) return null;
  const key = issueKey(issue);
  if (!key || !i18n.exists(`pipeline:issues.${key}.title`)) {
    return { ...issue, untranslated: true };
  }
  const params = { status: httpStatusFrom(issue.message || issue.technical_detail) };
  return {
    ...issue,
    title: i18n.t(`pipeline:issues.${key}.title`, params),
    message: i18n.t(`pipeline:issues.${key}.message`, params),
    action: i18n.t(`pipeline:issues.${key}.action`, params),
    untranslated: false,
  };
}

// The spider's raw per-source fetch_note is mostly free text (exception
// messages, HTTP bodies), but a handful of notes are fixed sentences from
// backend/services/pipeline/source_diagnostics.py's build_fetch_note and
// backend/scraper/spiders/source_rss.py. Those get a translated sentence;
// anything else returns null and the caller shows the raw note as-is.
const FETCH_NOTE_PATTERNS = [
  { pattern: /^Returned 0 articles\.?$/i, key: 'noArticles' },
  { pattern: /^Blocked \(HTTP (\d{3}|None)\) - likely anti-bot protection/i, key: 'blocked', status: 1 },
  { pattern: /^HTTP (\d{3}) - the source's page could not be fetched\./i, key: 'httpError', status: 1 },
  { pattern: /^Telegram channel unavailable \(private, not a channel, or missing\)\.?$/i, key: 'telegramUnavailable' },
  { pattern: /^Could not fetch this tweet \(deleted, private\/protected, or fxtwitter\.com is unavailable\)\.?$/i, key: 'tweetUnavailable' },
  { pattern: /^APIFY_API_TOKEN not set - (\w+) sources require Apify/i, key: 'apifyMissing', platform: 1 },
];

export function translateFetchNote(note) {
  const text = String(note || '').trim();
  if (!text) return null;
  for (const entry of FETCH_NOTE_PATTERNS) {
    const match = text.match(entry.pattern);
    if (!match) continue;
    const params = {};
    if (entry.status) params.status = match[entry.status] === 'None' ? '?' : match[entry.status];
    if (entry.platform) {
      const raw = match[entry.platform].toLowerCase();
      params.platform = i18n.t(`sources:types.${raw}`, { defaultValue: match[entry.platform] });
    }
    return i18n.t(`pipeline:fetchNotes.${entry.key}`, params);
  }
  return null;
}
