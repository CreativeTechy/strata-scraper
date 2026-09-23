# X hashtag collection: research and proposed spike

Research date: 23 September 2026. Scope: quick research pass, requested by the user, against local checkout `806dd3f` and current primary documentation.

## Decision

For “enter a hashtag and return 10–20 tweets without asking the user to log into X,” there are credible hosted API options. For “run our own reliable hashtag scraper with no X accounts, cookies, vendor key, or paid access anywhere,” this review found no defensible production solution.

Recommend benchmarking TwitterAPI.io against an Apify actor suited to small searches, keeping Apify available. Consider the official X API if avoiding third-party scraping infrastructure matters more than unit price. This is a recommendation for a spike, not a claim of measured reliability: no paid searches or authenticated provider benchmarks were run.

## What this repository already does

- `backend/scraper/spiders/source_rss.py:639` implements hashtag discovery through Google CSE and Apify, running both when configured. The guide in AGENTS.md describes the older CSE-only behavior.
- `backend/scraper/apify_twitter.py:61` sends `searchTerms`, `maxItems`, and `sort: Latest`; settings default to `apidojo/tweet-scraper` and 20 tweets.
- The Apify normalizer already maps tweet URL, text, author, timestamp, and originating source into ordinary article items. It does not require an X account from our user.
- `_hydrate_tweet` in `source_rss.py:1234` retrieves a known status through FxTwitter. This is retrieval after discovery; it cannot enumerate a hashtag through the endpoint currently used.
- `backend/scraper/web_search.py` makes one CSE request, capped at ten web results, without pagination. Only status URLs survive hashtag discovery, so this path cannot itself deliver twenty tweets and may deliver fewer than ten.
- `backend/services/articles/collect.py:210` deduplicates by exact URL string and exempts tweet URLs from the 200-character article minimum. Short tweets therefore do not need a blanket relaxation of article validation.
- `backend/scraper/apify_common.py` collapses most errors into an empty list; billing failures can be surfaced separately. A new search provider should distinguish a successful empty result from failure.

## Authentication: three different requirements

| Interpretation | Feasibility |
| --- | --- |
| Dashboard users never sign into X | Feasible with a backend provider key or an official application token |
| Our team never maintains X scraping accounts/cookies | Feasible with a hosted provider; its upstream authentication remains its concern |
| No credentials or authenticated upstream access anywhere | Not established by this research; public mirrors do not prove anonymous upstream access |

“No Twitter API key required” often describes only the caller's experience. It does not establish that a provider scrapes anonymously internally.

## Options and evidence

### TwitterAPI.io: first alternative to benchmark

The documented advanced-search endpoint accepts `query`, `queryType` (`Latest` or `Top`), and a cursor. It returns up to twenty tweets per page, sometimes fewer, plus pagination fields. Authentication uses a vendor `X-API-Key`. This fits the requested batch size and maps closely to the existing tweet normalizer. [Endpoint documentation](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search).

The provider advertises no Twitter authentication requirement for its read service. That is a vendor claim, not an independently audited upstream architecture. [Provider description](https://twitterapi.io/readme).

Published tweet pricing is $0.15 per 1,000 returned tweets: a twenty-tweet response is approximately $0.003 before any other applicable charges. For 1,000 such searches returning twenty tweets each, the arithmetic is $3. Extra pages and discarded results increase effective cost per accepted tweet. [Pricing](https://twitterapi.io/pricing).

Unknowns: measured freshness, Arabic hashtag coverage, sparse-query behavior, real latency, minimum account funding, and contractual suitability for our storage/export workflow.

### Apify: retain, but revisit the configured actor

The currently configured `apidojo/tweet-scraper` documents a minimum of fifty tweets per query. It also documents restricted free-plan demo use and no free-plan API access. This conflicts with our default request for twenty; it is a concrete compatibility concern, not proof that a particular existing run failed for this reason. [Actor documentation](https://apify.com/apidojo/tweet-scraper).

The same maintainer directs smaller searches to `apidojo/twitter-scraper-lite` (“Unlimited”). Its documentation advertises no minimum, $0.016 per standard query including approximately forty tweets, and one concurrent run. Thus 1,000 small queries would have a $16 query component, excluding plan costs or additional events. Validate the input/output schema and actual invoice before switching the actor setting. [Alternative actor and pricing](https://apify.com/apidojo/twitter-scraper-lite).

### Official X API: direct supported access

Recent search supports hashtag operators and covers the last seven days. Older project windows require full-archive search. [Search documentation](https://docs.x.com/x-api/posts/search/introduction). Requests use a bearer token; this can be a backend integration without dashboard users completing an X login. [Endpoint reference](https://docs.x.com/x-api/posts/search-recent-posts).

Current published pricing is pay-per-use, with Post reads at $0.005 per resource: twenty posts are approximately $0.10, or $100 for 1,000 twenty-post searches before repeat-resource deduplication and other billable resources. User reads have separate pricing, so author expansions should be checked when estimating the complete response cost. [Official pricing](https://docs.x.com/x-api/getting-started/pricing).

This is attractive if the volume is modest and direct platform access is the priority; the old assumption that every official integration necessarily requires a large monthly subscription is no longer supported by the current pricing page.

### Options that do not resolve this requirement

| Approach | Assessment |
| --- | --- |
| Twikit | README's search example first logs into an account. “Without an API key” does not mean without authentication. [Repository](https://github.com/d60/twikit) |
| twscrape | Explicitly requires authorized X accounts and recommends session cookies. Does not meet the no-account-maintenance interpretation. [Repository](https://github.com/vladkens/twscrape) |
| Nitter | Self-hosting requires real account sessions; using a public instance moves that dependency to its operator. The upstream repository currently displays archived status. [Session documentation](https://github.com/zedeus/nitter/wiki/Creating-session-tokens), [repository](https://github.com/zedeus/nitter) |
| snscrape | Maintainer issue history documents guest-search failures. These older reports are failure evidence, not a fresh benchmark of every fork; no validated current anonymous solution was established. [Maintainer issue](https://github.com/JustAnotherArchivist/snscrape/issues/783) |
| CSE plus FxTwitter | Already implemented, limited by indexed tweet discovery and a ten-result request. Google says CSE JSON API is unavailable to new customers and existing customers must transition by January 1, 2027. [Google documentation](https://developers.google.com/custom-search/v1/overview) |
| Generic browser automation / HTML extraction | Rendering JavaScript does not itself grant access to login-gated search results. No verified logged-out hashtag-search route was found in this quick pass. |

## Proposed implementation spike

Keep collection-only behavior and the existing JSONL contract. Introduce a narrow search interface, for example `search_hashtag(tag, limit, start_at, end_at, cursor)`, returning normalized articles plus provider, continuation, and explicit outcome metadata. Keep provider details outside the dashboard.

1. Add a TwitterAPI.io adapter and a configurable provider selection. Preserve Apify as an alternative. Do not automatically run every paid provider for every query: enable an explicit fallback policy with one total spend/time budget.
2. Decode and normalize the stored hashtag path, remove a leading `#` once, and preserve Unicode. Treat a hashtag input as a hashtag, not an unrestricted provider query expression. Encode query parameters through the HTTP client.
3. Request latest matching posts within the project's date window. Translate each provider's date syntax separately; use local window validation as a second check. Do not assume all X-like APIs implement identical operators.
4. Verify exact hashtag membership from entities where available, with a Unicode-aware text fallback. Deduplicate by tweet ID across providers and normalize URLs consistently; exact URL comparison alone misses `twitter.com` versus `x.com` variants.
5. Paginate until the target number of accepted unique posts is reached, results are exhausted, or an explicit page/time/cost cap is reached. A page of twenty raw results is not necessarily twenty accepted or newly stored articles.
6. Surface `success`, `empty`, `partial`, `rate_limited`, `auth_error`, `billing_error`, and `unavailable` distinctly. Preserve the existing source attribution, run snapshot, `analysis_status='pending'`, and export rules.
7. Validate adapter normalization, pagination bounds, duplicate IDs, Unicode tags, provider errors, and preservation of source identity through the collection pipeline.

Product wording should promise **up to twenty matching tweets**, not exactly twenty for every hashtag. An obscure tag may have fewer posts; existing URLs and out-of-window posts may also reduce the number newly saved. If the interface means twenty displayed tweets, it can show existing matching records as well, but that is a separate contract from collecting twenty new records.

## Benchmark and decision gate

Use six test cases: a high-volume English tag, a medium-volume tag, an Arabic tag such as `#لبنان`, a niche local tag, a nonexistent tag, and a tag constrained to a historical project window. Compare identical queries across the shortlisted providers, repeat active cases, and record:

- Returned, exact-tag-matching, unique, in-window, and newly saved counts separately.
- Tweet timestamps and freshness, complete text, author, and stable URL.
- End-to-end duration, pages, failure classification, and actual provider charges.
- Whether any end user or operator must provide X credentials.

Suggested pass criteria: active control tags yield at least ten valid unique posts within the configured budget; pagination can fill twenty when sufficient accessible posts exist; nonexistent tags terminate cleanly; Arabic is preserved; failures never masquerade as successful empty searches. Choose a latency target appropriate to background collection versus an interactive search experience before judging results.

## Limits and reproducibility

This pass inspected the actual local implementation and current primary documentation. Firecrawl was installed but its keyless request was rejected from this environment; research used web search/open tools instead. No SSH, production changes, purchases, provider credentials, or live paid tweet searches were used. No application code changed and no application tests were run for this documentation-only deliverable.

The remaining evidence gap is operational: vendor documentation establishes plausible capability, not comparative reliability. The next experiment is a small controlled provider benchmark, not rebuilding profile scraping or committing to an anonymous scraping promise.

Rerun inputs: workflow `firecrawl-deep-research` with web fallback; topic `strata-scraper X hashtag discovery without user authentication`; depth `quick`; output `Markdown research and spike proposal`.

## Follow-up: Sotwe browser feasibility

An automated in-app browser visit to `https://www.sotwe.com/hashtag/AI` on the same date initially showed Cloudflare verification, then loaded twenty post cards without a login, manual CAPTCHA interaction, or user action. This is browser feasibility evidence, not a test of a fresh browser profile, production headless Chromium, or the deployment server's IP. Direct HTTP requests had returned 403.

Rendered cards expose `.tweet-card`, author links, hashtag links, and `time[datetime]` with absolute timestamps. No original status URLs were found in the inspected rendered anchor links. Opening one post's More menu exposed Report; the inspected Share interaction did not establish a usable original tweet URL. Original tweet identity remains an acceptance blocker for lossless integration with the existing article URL contract. Do not synthesize a tweet ID or treat a profile URL as a post URL.

Proposed transport: an isolated Playwright/Chromium worker, one reused browser per collection batch, one hashtag page at a time, bounded navigation/scrolling, and a short query cache. Extract all cards in one DOM pass; verify exact hashtag membership, obtain original IDs, normalize into existing article items, and feed the existing streaming pipeline. Run the browser outside the Scrapy reactor's blocking path. Retain automatic browser verification only if it completes normally; interactive challenges should produce a blocked outcome rather than a manual operating dependency. No authenticated-provider fallback should run in this zero-credential mode.

The public feed is labeled Top Tweets; do not promise chronological latest search. Server reachability, Arabic coverage, stable tweet IDs, pagination, freshness, and repeatability remain unverified.

There is also a concrete usage constraint: [Sotwe's published terms](https://www.sotwe.com/terms-of-service) describe personal, non-commercial use and prohibit copying/distributing site information. This does not establish permission for this project's storage/export workflow. Obtain appropriate permission before treating Sotwe as a production data source; browser accessibility alone is not evidence of permitted reuse. The robots.txt request returned 403, so its rules were not verified.
