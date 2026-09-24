import { countryName } from './format.js';

// Fixed backend discovery messages carry live names, counts, and URLs. Keep
// those values intact while translating the surrounding product copy. Unknown
// messages remain available as diagnostic text rather than being discarded.
const LOG_PATTERNS = [
  [/^Searching the web for who really competes in this market \((\d+) queries\)\.\.\.$/, 'searchingMarket', ([, count]) => ({ count: Number(count) })],
  [/^Search returned nothing usable; falling back to the model's own knowledge\.$/, 'searchFallback'],
  [/^Collected (\d+) search results to ground the candidate list\.$/, 'groundedCandidates', ([, count]) => ({ count: Number(count) })],
  [/^Asking the model for (\d+) local and (\d+) large competitors\.\.\.$/, 'askingSplit', ([, local, global]) => ({ local: Number(local), global: Number(global) })],
  [/^Asking the model for competitor candidates\.\.\.$/, 'askingCandidates'],
  [/^No in-country candidates; retrying without the country restriction\.\.\.$/, 'retryingWithoutCountry'],
  [/^Model suggested (\d+) candidates; checking each\.\.\.$/, 'checkingCandidates', ([, count]) => ({ count: Number(count) })],
  [/^No candidate passed the country filter; keeping the unfiltered list instead\.$/, 'countryFallback'],
  [/^(.+): checking (.+) is reachable\.\.\.$/, 'checkingWebsite', ([, name, url]) => ({ name, url })],
  [/^(.+): site is (reachable|unreachable)\.$/, 'websiteStatus', ([, name, status]) => ({ name, statusKey: status })],
  [/^(.+): searching DuckDuckGo for .+ official site\.\.\.$/, 'searchingOfficialSite', ([, name]) => ({ name })],
  [/^(.+): no DuckDuckGo results, falling back to Bing\.\.\.$/, 'searchingOfficialSiteFallback', ([, name]) => ({ name })],
  [/^(.+): found (\d+) search results?\.$/, 'foundSearchResults', ([, name, count]) => ({ name, count: Number(count) })],
  [/^(.+): rejected — no reachable website found\.$/, 'rejectedNoWebsite', ([, name]) => ({ name })],
  [/^(.+): rejected — could not corroborate that this company exists\.$/, 'rejectedUncorroborated', ([, name]) => ({ name })],
  [/^(.+): accepted\.$/, 'accepted', ([, name]) => ({ name })],
  [/^(.+): checking for a site feed\.\.\.$/, 'checkingFeed', ([, name]) => ({ name })],
  [/^(.+): found feed (.+)$/, 'foundFeed', ([, name, url]) => ({ name, url })],
  [/^(.+): searching the web for their real accounts and hashtags\.\.\.$/, 'searchingAccounts', ([, name]) => ({ name })],
  [/^(.+): search returned nothing usable; falling back to the model's own knowledge\.$/, 'accountSearchFallback', ([, name]) => ({ name })],
  [/^(.+): found (\d+) search results? to ground channel discovery\.$/, 'groundedChannels', ([, name, count]) => ({ name, count: Number(count) })],
  [/^(.+): searching for review and discussion pages\.\.\.$/, 'searchingReviews', ([, name]) => ({ name })],
  [/^(.+): found (\d+) matching review\/discussion pages?\.$/, 'foundReviews', ([, name, count]) => ({ name, count: Number(count) })],
  [/^(.+): no matching review or discussion pages found\.$/, 'noReviews', ([, name]) => ({ name })],
  [/^(.+): asking the model for channels — .+$/, 'askingChannels', ([, name]) => ({ name })],
  [/^(.+): dropped (\d+) X handles? that didn't resolve\.$/, 'droppedX', ([, name, count]) => ({ name, count: Number(count) })],
  [/^(.+): dropped (\d+) channels? .+$/, 'droppedRegion', ([, name, count]) => ({ name, count: Number(count) })],
  [/^(.+): found (\d+) channels?\.$/, 'foundChannels', ([, name, count]) => ({ name, count: Number(count) })],
];

export function translateDiscoveryLog(entry, t) {
  const raw = String(entry?.message || '').trim();
  for (const [pattern, key, params] of LOG_PATTERNS) {
    const match = raw.match(pattern);
    if (!match) continue;
    const values = params ? params(match) : {};
    if (values.statusKey) {
      values.status = t(`discoveryLog.website.${values.statusKey}`);
      delete values.statusKey;
    }
    return { text: t(`discoveryLog.events.${key}`, values), translated: true };
  }
  return { text: raw, translated: false };
}

export function translateRejectionReason(item, t) {
  const code = item?.reason_code;
  if (code && t(`competitors.rejectionReasons.${code}`, { defaultValue: '' })) {
    const params = { ...(item.reason_params || {}) };
    if (code === 'outsideCountries' && params.country) {
      params.country = countryName(params.country, params.country);
    }
    return t(`competitors.rejectionReasons.${code}`, params);
  }
  return String(item?.reason || '');
}
