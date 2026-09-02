"""Central configuration for the generic source pipeline.

Single source of truth for the dynamic source list and for the credentials each
stage needs. Everything reads from here so swapping sources or rotating keys is
a one-place change.
"""

import os
from pathlib import Path
from urllib.parse import urlparse

from content_guard import is_tweet_url

from . import db

# This file lives at backend/app/core/settings.py, three levels under
# backend/ - BASE_DIR must still resolve to backend/ itself, since that's
# where .env actually lives (see CLAUDE.md: "loads backend/.env manually").
BASE_DIR = Path(__file__).resolve().parents[2]
DOTENV_FILE = BASE_DIR / ".env"

def _load_dotenv():
    """Load simple KEY=VALUE pairs from backend/.env if present."""
    if not DOTENV_FILE.exists():
        return

    try:
        for raw_line in DOTENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except Exception:
        # If dotenv parsing fails, keep going with the already-loaded env.
        pass


_load_dotenv()


DATABASE_URL = db.get_database_url()

# --- LLM provider ------------------------------------------------------------
# `LLM_PROVIDER` picks which backend every AI feature talks to. In this app
# that means discovery only: project metadata suggestions, project keyword/
# hashtag/username/source discovery, and competitor discovery - the AI helps
# decide *what to collect*, never interprets what was collected. Everything provider-specific - credentials, base URL, default model, and
# request/response shape - is resolved here and in llm_client.py; feature
# modules only ever call llm_client.chat_completion() and never branch on the
# provider themselves.
#
# OpenAI uses its Responses API; DeepSeek (and any other OpenAI-compatible
# provider) uses the chat-completions shape. Adding a new OpenAI-compatible
# provider only requires a new entry in _LLM_PROVIDER_DEFAULTS plus its two
# env vars below - no changes to llm_client.py's request logic.
_LLM_PROVIDER_DEFAULTS = {
    "openai": {
        "api_key_env": "OPENAI_API_KEY",
        "base_url_env": "OPENAI_CHAT_BASE_URL",
        "model_env": "OPENAI_CHAT_MODEL",
        "default_base_url": "https://api.openai.com/v1/responses",
        "default_model": "gpt-5-nano",
        "api_style": "responses",
    },
    "deepseek": {
        "api_key_env": "DEEPSEEK_API_KEY",
        "base_url_env": "DEEPSEEK_CHAT_BASE_URL",
        "model_env": "DEEPSEEK_CHAT_MODEL",
        "default_base_url": "https://api.deepseek.com/v1/chat/completions",
        # "deepseek-chat"/"deepseek-reasoner" are DeepSeek's deprecated legacy
        # model aliases - this is the current supported model name.
        "default_model": "deepseek-v4-pro",
        "api_style": "chat_completions",
    },
    "ollama": {
        # Ollama serves an OpenAI-compatible chat-completions endpoint on
        # localhost and ignores the Authorization header entirely, so there
        # is no real key to set - OLLAMA_API_KEY exists only so LLM_API_KEY
        # is non-empty and llm_client's "not configured" guard doesn't fire.
        "api_key_env": "OLLAMA_API_KEY",
        "base_url_env": "OLLAMA_CHAT_BASE_URL",
        "model_env": "OLLAMA_CHAT_MODEL",
        "default_base_url": "http://localhost:11434/v1/chat/completions",
        "default_model": "llama3.1",
        "api_style": "chat_completions",
    },
}

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "deepseek").strip().lower() or "deepseek"
if LLM_PROVIDER not in _LLM_PROVIDER_DEFAULTS:
    LLM_PROVIDER = "deepseek"

# Per-provider env vars are kept as top-level names (OPENAI_API_KEY et al. are
# unchanged from before this switch existed, so existing deployments that only
# ever set the OpenAI vars keep working with no changes). Only the active
# provider's values are used by llm_client.py, via LLM_API_KEY/LLM_CHAT_*
# below.
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
# OPENAI_CHAT_BASE_URL/OPENAI_CHAT_MODEL are kept as the env var names for
# backward compatibility with existing deployments; they now point at the
# Responses API (see llm_client.py), not chat completions.
OPENAI_CHAT_BASE_URL = os.environ.get(
    "OPENAI_CHAT_BASE_URL", _LLM_PROVIDER_DEFAULTS["openai"]["default_base_url"]
)
OPENAI_CHAT_MODEL = os.environ.get("OPENAI_CHAT_MODEL", _LLM_PROVIDER_DEFAULTS["openai"]["default_model"])
# gpt-5-nano (the default OPENAI_CHAT_MODEL) is a reasoning model: the
# Responses API spends part of max_output_tokens on hidden reasoning tokens
# before writing any visible output. Left unset, OpenAI's default effort
# ("medium") can burn the *entire* budget on reasoning and return nothing
# visible even after llm_client.py's automatic retry-with-more-tokens - "low"
# leaves enough room for the actual JSON/text reply. One of minimal/low/medium/high.
OPENAI_REASONING_EFFORT = os.environ.get("OPENAI_REASONING_EFFORT", "low").strip().lower()

DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_CHAT_BASE_URL = os.environ.get(
    "DEEPSEEK_CHAT_BASE_URL", _LLM_PROVIDER_DEFAULTS["deepseek"]["default_base_url"]
)
DEEPSEEK_CHAT_MODEL = os.environ.get("DEEPSEEK_CHAT_MODEL", _LLM_PROVIDER_DEFAULTS["deepseek"]["default_model"])

# See the "ollama" entry above re: this key being a placeholder, not a secret.
OLLAMA_API_KEY = os.environ.get("OLLAMA_API_KEY", "ollama")
OLLAMA_CHAT_BASE_URL = os.environ.get(
    "OLLAMA_CHAT_BASE_URL", _LLM_PROVIDER_DEFAULTS["ollama"]["default_base_url"]
)
OLLAMA_CHAT_MODEL = os.environ.get("OLLAMA_CHAT_MODEL", _LLM_PROVIDER_DEFAULTS["ollama"]["default_model"])

_LLM_PROVIDER_VALUES = {
    "openai": {
        "api_key": OPENAI_API_KEY,
        "base_url": OPENAI_CHAT_BASE_URL,
        "model": OPENAI_CHAT_MODEL,
        "reasoning_effort": OPENAI_REASONING_EFFORT,
    },
    "deepseek": {
        "api_key": DEEPSEEK_API_KEY,
        "base_url": DEEPSEEK_CHAT_BASE_URL,
        "model": DEEPSEEK_CHAT_MODEL,
        "reasoning_effort": None,
    },
    "ollama": {
        "api_key": OLLAMA_API_KEY,
        "base_url": OLLAMA_CHAT_BASE_URL,
        "model": OLLAMA_CHAT_MODEL,
        "reasoning_effort": None,
    },
}

# Provider-neutral values llm_client.py (and, indirectly, every feature
# module) actually reads. Switching providers is a single env var
# (LLM_PROVIDER) away - nothing else needs to change.
_active_provider = _LLM_PROVIDER_DEFAULTS[LLM_PROVIDER]
_active_values = _LLM_PROVIDER_VALUES[LLM_PROVIDER]
LLM_API_KEY = _active_values["api_key"]
LLM_CHAT_BASE_URL = _active_values["base_url"]
LLM_CHAT_MODEL = _active_values["model"]
LLM_API_STYLE = _active_provider["api_style"]
LLM_API_KEY_ENV_NAME = _active_provider["api_key_env"]
LLM_REASONING_EFFORT = _active_values["reasoning_effort"]

def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


# How long a single chat_completion() HTTP call waits for a response before
# giving up. Raise this for a slow remote backend (a self-hosted vLLM/Ollama
# box, a Colab instance behind an ngrok tunnel) where a real response can
# legitimately take longer than 60s.
#
# Call sites pass their own per-call budget, sized for a fast hosted API like
# DeepSeek. This value is the *floor* under all of them (see
# llm_client._resolve_timeout), so pointing the app at a slower backend is one
# env var rather than an edit to every chat_completion() call in the codebase.
LLM_REQUEST_TIMEOUT_SECONDS = _env_int("LLM_REQUEST_TIMEOUT_SECONDS", 60)

# Serverless GPU backends (RunPod, Modal, and friends) keep no warm worker
# between calls: the first request after an idle period blocks while a worker
# boots and loads model weights, which on its own can outlast the entire
# inference budget above. When this is set, a call that times out is retried
# once with this longer timeout instead of failing - the boot the first
# attempt paid for is done or nearly done by then, so the retry generally
# lands on a warm worker. 0 (the default) disables the retry, which is right
# for any always-warm provider.
LLM_COLD_START_TIMEOUT_SECONDS = _env_int("LLM_COLD_START_TIMEOUT_SECONDS", 0)

SCHEDULER_POLL_SECONDS = int(os.environ.get("SCHEDULER_POLL_SECONDS", "30") or 30)
SCHEDULER_STALE_RUN_MINUTES = int(os.environ.get("SCHEDULER_STALE_RUN_MINUTES", "180") or 180)


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


# Hybrid-reasoning models (Qwen3 and kin) think out loud by default, writing a
# <think>...</think> block into the response before any real answer. That costs
# most of the token budget - and therefore most of the wall clock - on work no
# caller here wants, since every LLM call in this app asks for a short JSON
# object rather than a reasoned essay. Set this when the backend serves such a
# model and it will be asked to answer directly. Only honoured by
# OpenAI-compatible chat-completions backends that accept vLLM's
# chat_template_kwargs (llm_client._build_request_body); harmless elsewhere.
LLM_DISABLE_THINKING = _env_bool("LLM_DISABLE_THINKING", False)


# --- Scraping proxy: optional network egress ---------------------------------
# Any source can anti-bot-block requests from datacenter/cloud IP ranges (see
# scraper/spiders/source_rss.py's BLOCKED_STATUS_CODES/blocked-source
# reporting, and services/pipeline/pipeline.py's summary of it). Routing
# requests through a proxy is one mitigation for that. Unset (the default)
# changes nothing - requests go out directly. Full proxy URL, e.g.
# `http://user:pass@host:port` - Scrapy's HttpProxyMiddleware parses embedded
# basic-auth credentials from the URL itself, no separate credential fields
# needed.
# SCRAPE_PROXY_URL is the fallback used for every source type (rss/web/
# keyword/social/username/hashtag, and reddit/telegram when their own proxy
# below is unset). REDDIT_PROXY_URL/TELEGRAM_PROXY_URL override it for just
# those two platforms, e.g. to route them through a different proxy pool.
SCRAPE_PROXY_URL = os.environ.get("SCRAPE_PROXY_URL", "").strip()
REDDIT_PROXY_URL = os.environ.get("REDDIT_PROXY_URL", "").strip()
TELEGRAM_PROXY_URL = os.environ.get("TELEGRAM_PROXY_URL", "").strip()

# --- Reddit OAuth (optional) -------------------------------------------------
# Reddit's officially sanctioned path for programmatic access - an app-only
# ("client_credentials") token via a registered Reddit app - is far less
# likely to be blocked than the unauthenticated `.json` endpoints, at the
# cost of requiring credentials (which the rest of this source type
# deliberately doesn't). Both unset (the default) keeps using the public
# `.json` endpoints with no behavior change. Register an app (type "script")
# at https://www.reddit.com/prefs/apps to get a client id/secret.
REDDIT_OAUTH_CLIENT_ID = os.environ.get("REDDIT_OAUTH_CLIENT_ID", "").strip()
REDDIT_OAUTH_CLIENT_SECRET = os.environ.get("REDDIT_OAUTH_CLIENT_SECRET", "").strip()
# Reddit requires a distinctive User-Agent for API use (generic/browser UAs
# are rate-limited harder) - see https://github.com/reddit-archive/reddit/wiki/API#rules.
REDDIT_OAUTH_USER_AGENT = os.environ.get("REDDIT_OAUTH_USER_AGENT", "").strip()


def reddit_oauth_configured() -> bool:
    return bool(REDDIT_OAUTH_CLIENT_ID and REDDIT_OAUTH_CLIENT_SECRET)


# --- Google Custom Search (optional) -----------------------------------------
# General-web-search tier for "keyword" sources (see scraper/web_search.py and
# source_rss.py's start()) - a keyword otherwise only reaches Google News via
# its RSS feed, missing ordinary (non-news) web pages that mention it. Create
# a Programmable Search Engine at https://programmablesearchengine.google.com/
# (set it to search the whole web) for the engine id, and an API key with the
# Custom Search API enabled at https://console.cloud.google.com/apis/credentials.
# Free for 100 queries/day, then billed - unconfigured (the default) simply
# skips this tier and keyword sources behave exactly as before.
GOOGLE_CSE_API_KEY = os.environ.get("GOOGLE_CSE_API_KEY", "").strip()
GOOGLE_CSE_ENGINE_ID = os.environ.get("GOOGLE_CSE_ENGINE_ID", "").strip()


def google_cse_configured() -> bool:
    return bool(GOOGLE_CSE_API_KEY and GOOGLE_CSE_ENGINE_ID)


# --- GDELT (optional, on by default) -----------------------------------------
# Free, no-key news-search tier for "keyword" sources (see scraper/gdelt.py) -
# GDELT's own global news index, queried alongside (not instead of) the
# Google News RSS feed, so a keyword's news coverage doesn't depend solely on
# resolving Google's redirect-wrapper links. Set to false/0/no to disable.
GDELT_ENABLED = os.environ.get("GDELT_ENABLED", "true").strip().lower() not in {"false", "0", "no"}


# --- Apify (optional) - LinkedIn scraping tier -------------------------------
# LinkedIn requires an authenticated, JS-rendered session for every page (even
# a public company page) - there is no unauthenticated HTML worth fetching the
# way there is for X/Reddit/Telegram, so "linkedin" sources go through Apify's
# hosted actors instead of Scrapy's own downloader (see scraper/apify_linkedin.py).
# Get a token at https://console.apify.com/settings/integrations. Unconfigured
# (the default), "linkedin" sources report 0 articles with an explanatory
# fetch note rather than a silent miss - same contract as the CSE/GDELT tiers.
APIFY_API_TOKEN = os.environ.get("APIFY_API_TOKEN", "").strip()
# Both default actors are from the same vendor (harvestapi) and return dataset
# items in the same post shape (linkedinUrl/content/author/postedAt), so one
# normalizer covers both - see apify_linkedin.py's _article_from_post. Override
# either to point at a different actor with the same input/output contract
# (targetUrls/searchQueries in, a list of post objects out).
APIFY_LINKEDIN_POSTS_ACTOR = os.environ.get("APIFY_LINKEDIN_POSTS_ACTOR", "harvestapi/linkedin-company-posts").strip()
APIFY_LINKEDIN_SEARCH_ACTOR = os.environ.get("APIFY_LINKEDIN_SEARCH_ACTOR", "harvestapi/linkedin-post-search").strip()
APIFY_LINKEDIN_MAX_POSTS = _env_int("APIFY_LINKEDIN_MAX_POSTS", 20)
# A synchronous actor run (fetch + scrape LinkedIn's own JS-rendered pages)
# routinely takes tens of seconds, well past a normal HTTP request's budget -
# see apify_linkedin.py's run-sync-get-dataset-items call.
APIFY_TIMEOUT_SECONDS = _env_int("APIFY_TIMEOUT_SECONDS", 120)


def apify_configured() -> bool:
    return bool(APIFY_API_TOKEN)


# --- Apify (optional) - Twitter/X scraping tier ------------------------------
# Reuses APIFY_API_TOKEN/APIFY_TIMEOUT_SECONDS above - this only adds the
# actor id and result cap for "keyword"/"hashtag" X sources (see
# scraper/apify_twitter.py). Runs alongside the existing Google-CSE
# tweet-link-discovery tier for "hashtag" sources, not instead of it: CSE
# finds tweet URLs to hydrate via fxtwitter.com, this gets full tweet content
# directly from the search actor's own dataset, so a miss in one doesn't cost
# the other. Unconfigured (the default), this tier is silently skipped - a
# keyword/hashtag source's other tiers already report their own diagnostics.
APIFY_TWITTER_SEARCH_ACTOR = os.environ.get("APIFY_TWITTER_SEARCH_ACTOR", "apidojo/tweet-scraper").strip()
APIFY_TWITTER_MAX_TWEETS = _env_int("APIFY_TWITTER_MAX_TWEETS", 20)


# --- Skip already-collected articles -----------------------------------------
# When a scraped URL is already in the `articles` table, skip saving it again
# instead of re-upserting a row whose text we already hold (see
# services/articles/collect.py). Counted per source as "already scraped" so
# the run breakdown still shows the source produced something. Set false to
# force every run to re-save everything it scrapes, e.g. to refresh
# fetched_at or to re-run story-group assignment over known URLs.
SKIP_EXISTING_URLS = _env_bool("SKIP_EXISTING_URLS", True)


# --- Google News link-decode concurrency -------------------------------------
# How many news.google.com/rss/articles/... redirect-wrapper links
# source_rss.py's parse_feed() decodes at once (see googlenewsdecoder in
# CLAUDE.md). A Google News search feed carries up to ~100 of these, each
# decode being a real network round trip (fetch the wrapper page, then a
# signed batchexecute call) - resolved one at a time this was measured at
# 7-11 minutes for a single feed, blocking the whole crawl for that entire
# span. This endpoint's own rate-limiting is undocumented, so the default is
# a starting point to tune from, not a researched ceiling - lower it if you
# see a rise in decode failures
# (skipped links, not errors - see _resolve_google_news_link).
try:
    GOOGLE_NEWS_DECODE_CONCURRENCY = max(1, int(os.environ.get("GOOGLE_NEWS_DECODE_CONCURRENCY", "8")))
except ValueError:
    GOOGLE_NEWS_DECODE_CONCURRENCY = 8


# Apply pending schema migrations when the API starts. Set false to manage them
# out of band (`python migrate.py`) — e.g. when several backend replicas share
# one database and only a deploy step should migrate it.
MIGRATE_ON_STARTUP = _env_bool("MIGRATE_ON_STARTUP", True)


# --- Auth -------------------------------------------------------------------
SESSION_COOKIE_NAME = os.environ.get("SESSION_COOKIE_NAME", "strata_session")
CSRF_COOKIE_NAME = os.environ.get("CSRF_COOKIE_NAME", "strata_csrf")
SESSION_TTL_HOURS = int(os.environ.get("SESSION_TTL_HOURS", "12") or 12)
# Cookies default to Secure (HTTPS-only). Set COOKIE_SECURE=false for plain-http
# local/dev deployments (e.g. this repo's docker-compose, which has no TLS
# termination configured) - the browser silently drops Secure cookies over http.
COOKIE_SECURE = _env_bool("COOKIE_SECURE", True)
COOKIE_SAMESITE = os.environ.get("COOKIE_SAMESITE", "lax").strip().lower()

# Comma-separated list of origins allowed to make credentialed cross-origin
# requests. The dashboard is normally served same-origin behind nginx/Vite's
# proxy, so this is mainly for local dev where the Vite dev server runs on a
# different port than uvicorn.
CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]

# Bootstrap admin, created on startup if the users table is empty.
ADMIN_BOOTSTRAP_USERNAME = os.environ.get("ADMIN_BOOTSTRAP_USERNAME", "").strip()
ADMIN_BOOTSTRAP_EMAIL = os.environ.get("ADMIN_BOOTSTRAP_EMAIL", "").strip()
ADMIN_BOOTSTRAP_PASSWORD = os.environ.get("ADMIN_BOOTSTRAP_PASSWORD", "").strip()


def _looks_like_feed_url(url: str) -> bool:
    url = (url or "").strip().lower()
    return any(
        token in url
        for token in (
            "/feed",
            "/rss",
            "/atom",
            ".xml",
            ".rss",
            ".rdf",
            "?feed=",
        )
    )


def _looks_like_reddit_url(url: str) -> bool:
    host = urlparse((url or "").strip()).netloc.lower().removeprefix("www.")
    return host == "reddit.com" or host.endswith(".reddit.com")


def _looks_like_telegram_url(url: str) -> bool:
    host = urlparse((url or "").strip()).netloc.lower().removeprefix("www.")
    return host in {"t.me", "telegram.me"}


def _looks_like_linkedin_url(url: str) -> bool:
    host = urlparse((url or "").strip()).netloc.lower().removeprefix("www.")
    return host == "linkedin.com" or host.endswith(".linkedin.com")


def _looks_like_x_url(url: str) -> bool:
    host = urlparse((url or "").strip()).netloc.lower().removeprefix("www.")
    return host in {"x.com", "twitter.com"}


def _looks_like_hashtag_url(url: str) -> bool:
    if not _looks_like_x_url(url):
        return False
    path = (urlparse((url or "").strip()).path or "").rstrip("/").lower()
    return path.startswith("/hashtag/")


def _infer_source_type(url: str) -> str:
    """Best-guess source_type from a URL's own shape - no generic "social"
    bucket: an x.com/twitter.com URL resolves straight to whichever of
    tweet/hashtag/username it actually is, and every other social platform
    (Facebook, Instagram, TikTok, YouTube, Threads, ...) - none of which this
    app has any dedicated scraping tier for - falls through to "web" like any
    other non-feed URL, per the "we can't scrape it as its own platform, so
    treat it as a plain web page" rule.
    """
    if _looks_like_feed_url(url):
        return "rss"
    if _looks_like_reddit_url(url):
        return "reddit"
    if _looks_like_telegram_url(url):
        return "telegram"
    if _looks_like_linkedin_url(url):
        return "linkedin"
    if is_tweet_url(url):
        return "tweet"
    if _looks_like_hashtag_url(url):
        return "hashtag"
    if _looks_like_x_url(url):
        return "username"
    return "web"


KNOWN_SOURCE_TYPES = {"rss", "web", "hashtag", "keyword", "username", "tweet", "reddit", "telegram", "linkedin"}

# hashtag/keyword/username store a URL derived FROM the chosen type itself
# (see sources_store._derive_term_url) - it is always self-consistent with
# that type, so re-inferring from it would be circular (a keyword's Google
# News RSS URL would otherwise "infer" as rss). These three are the only
# types _resolve_source_type never overrides.
_TERM_DERIVED_TYPES = {"hashtag", "keyword", "username"}

# Every other known type is a dedicated platform whose URL shape alone
# determines it - if a user-entered URL for any of these actually belongs to
# a different one, _resolve_source_type corrects it below.
_PLATFORM_TYPES = {"reddit", "telegram", "linkedin", "tweet", "hashtag", "username"}


def _resolve_source_type(source_type_input: str, url: str) -> str:
    """Pick the source_type to store - for any entry, not just legacy rows:
    hashtag/keyword/username are trusted as explicitly chosen (see
    _TERM_DERIVED_TYPES), but every other type is corrected to whatever the
    URL itself actually is whenever that disagrees with a dedicated
    platform's own shape (reddit.com, t.me, linkedin.com, an x.com/twitter.com
    status/hashtag/profile link) - so e.g. pasting a tweet URL while "Reddit"
    is still selected still ends up stored as "tweet", not an uncrawlable
    "reddit" source. This also carries forward legacy rows from before
    reddit/telegram/linkedin/tweet/hashtag/username existed as their own
    types (previously lumped into a generic "social"/rss/web bucket).
    A plain rss/web pick is left alone even if its URL doesn't look feed-like
    (a homepage URL saved as "rss" is normal - see parse_homepage) or looks
    like a non-X social platform (Facebook/Instagram/... - see
    _infer_source_type - correctly stays "web", since there's no dedicated
    type to promote it to).
    """
    source_type_input = (source_type_input or "").strip().lower()
    inferred_type = _infer_source_type(url)
    if source_type_input in _TERM_DERIVED_TYPES:
        return source_type_input
    if source_type_input in KNOWN_SOURCE_TYPES:
        if inferred_type in _PLATFORM_TYPES and inferred_type != source_type_input:
            return inferred_type
        return source_type_input
    return inferred_type or "rss"


