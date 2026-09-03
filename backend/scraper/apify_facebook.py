"""Apify-backed Facebook scraping tier, for `facebook` sources.

Like LinkedIn and Threads (see scraper/apify_linkedin.py, scraper/
apify_threads.py), Facebook has no unauthenticated HTML worth fetching with
Scrapy's own downloader - a page, group, profile, or search results page is
either gated behind a login wall or served as a client-rendered shell - so
`facebook` sources go through Apify's hosted actors instead of the normal
per-source Scrapy request entirely (see scraper/spiders/source_rss.py's
start()), same replaces-the-seed-request treatment as `linkedin`/`threads`.

A `facebook` source's stored URL carries its own kind (see
services/sources/sources_store.py's _derive_facebook_url), same
URL-shape-encodes-kind pattern as `linkedin`/`threads`/`reddit`, with one
extra wrinkle: unlike LinkedIn's clean /company/ vs /in/ split, a plain
facebook.com/<slug> vanity URL is genuinely ambiguous between a public page
and a personal profile - Facebook uses the identical shape for both. The
other three kinds all have an unambiguous shape of their own:
  - group (facebook.com/groups/<slug>, or a facebook.com/share/g/<code>
    share-redirect link - confirmed live, the groups actor follows that
    redirect itself and returns real posts): that group's recent posts, via
    APIFY_FACEBOOK_GROUPS_ACTOR (apify/facebook-groups-scraper).
  - profile, unambiguous form (facebook.com/people/<name>/<id> or
    facebook.com/profile.php?id=<id>): that person's recent posts, via
    APIFY_FACEBOOK_PROFILE_ACTOR (cleansyntax/facebook-profile-posts-
    scraper).
  - search (facebook.com/search/top/?q=<term>): posts matching the query,
    via APIFY_FACEBOOK_SEARCH_ACTOR (cleansyntax/facebook-profile-posts-
    scraper's keyword-search endpoint - see apify_facebook_search_posts
    below for why this isn't apify/facebook-search-scraper, a
    nearby-sounding actor that turned out to be a Page directory finder,
    not a post search).
  - page, and profile's ambiguous form (facebook.com/<slug>): a bare vanity
    URL defaults to "page" (mirroring linkedin_kind's "company" default for
    an ambiguous bare term) unless it carries the `fb_kind=profile` marker
    _derive_facebook_url appends when the user explicitly picked "profile"
    for a bare slug - see facebook_kind() below. That marker is stripped
    before the URL is ever handed to an actor (_actor_target_url). Page
    kind's actor is APIFY_FACEBOOK_PAGES_ACTOR (apify/facebook-posts-
    scraper - NOT apify/facebook-pages-scraper, a nearby-sounding actor
    that returns page metadata, never post text - see settings.py).

Every actor/field choice here (payload shape, and the aliases
_article_from_post/_post_author/_published_value check) was confirmed
against real dataset items from a live run against each of the four actors,
not just guessed by name or documentation the way apify_threads.py's are -
apify/facebook-posts-scraper and apify/facebook-groups-scraper both use
url/text/time(ISO)/user.name; cleansyntax/facebook-profile-posts-scraper
instead uses url/message/timestamp(Unix epoch int)/author.name, hence the
extra aliases and the epoch-to-ISO conversion in _published_value.

Same contract as the other Apify tiers throughout: unconfigured or any
ordinary failure (bad token, actor error, timeout) returns [] rather than
raising, so one broken tier can't take down the rest of the crawl. The one
exception is a subscription/credit problem on the configured Apify account -
see apify_common.run_actor_sync - which raises ApifyBillingError instead,
since that's worth surfacing to the user.
"""

from datetime import datetime, timezone
from urllib.parse import parse_qs, urlencode, urlparse

from app.core import settings as config
from scraper.apify_common import run_actor_sync


def facebook_kind(url):
    """page/group/profile/search, inferred from a stored `facebook` source's
    URL shape - or None if the URL doesn't match any recognized Facebook
    page. A bare vanity path (facebook.com/<slug>) defaults to "page" unless
    it carries the fb_kind=profile marker (see module docstring).

    facebook.com/share/g/<code> is Facebook's own group-share redirect link
    (confirmed live: a plain HTTP 302 straight to facebook.com/groups/<id>) -
    recognized as "group" here rather than left to fall through to the
    "page" default, since the groups actor already follows that redirect
    itself and returns real posts, but the page-posts actor does not treat
    it as a page worth fetching (confirmed live: 0 posts either way, since
    it's not a page at all). Other /share/<type>/ links (p=post, r=reel,
    v=video) have no matching kind among page/group/profile/search and are
    left to the "page" default, same as before.
    """
    parsed = urlparse(url or "")
    path = (parsed.path or "").rstrip("/")
    query = parse_qs(parsed.query)
    if path.startswith("/groups/") or path.startswith("/share/g/"):
        return "group"
    if path.startswith("/search"):
        return "search"
    if path == "/profile.php" and (query.get("id") or [""])[0].strip():
        return "profile"
    if path.startswith("/people/"):
        return "profile"
    if not path:
        return None
    if (query.get("fb_kind") or [""])[0].strip().lower() == "profile":
        return "profile"
    return "page"


def facebook_search_query(url):
    """The `q` search term out of a search-kind source's stored URL."""
    return (parse_qs(urlparse(url or "").query).get("q") or [""])[0].strip()


def _actor_target_url(url):
    """The URL to actually hand an actor - strips the fb_kind marker
    (_derive_facebook_url's disambiguation-only artifact, not part of any
    real Facebook URL) so it's never sent as a live query param."""
    parsed = urlparse(url or "")
    query = {k: v for k, v in parse_qs(parsed.query).items() if k != "fb_kind"}
    cleaned = parsed._replace(query=urlencode(query, doseq=True))
    return cleaned.geturl()


def _post_url(post):
    return (post.get("url") or post.get("postUrl") or post.get("facebookUrl") or post.get("link") or "").strip()


def _post_text(post):
    return (post.get("text") or post.get("message") or post.get("content") or post.get("caption") or "").strip()


def _post_author(post):
    # `user` (apify/facebook-posts-scraper and apify/facebook-groups-scraper,
    # both confirmed live) and `author` (cleansyntax/facebook-profile-posts-
    # scraper, also confirmed live) are two different vendors' names for the
    # same nested {name, ...} shape - checked alongside the flatter
    # pageName/groupName/authorName aliases other actors might use.
    user = post.get("user") if isinstance(post.get("user"), dict) else {}
    author = post.get("author") if isinstance(post.get("author"), dict) else {}
    page = post.get("page") if isinstance(post.get("page"), dict) else {}
    group = post.get("group") if isinstance(post.get("group"), dict) else {}
    return (
        post.get("pageName")
        or post.get("groupName")
        or post.get("authorName")
        or user.get("name")
        or author.get("name")
        or page.get("name")
        or group.get("name")
        or ""
    ).strip()


def _published_value(post):
    """A publish-date value `timestamps.parse_published` can actually parse.
    `time` (an ISO string, from apify/facebook-posts-scraper and apify/
    facebook-groups-scraper, both confirmed live) is preferred when present;
    cleansyntax/facebook-profile-posts-scraper's `timestamp` (also confirmed
    live) is a raw Unix epoch int instead, which parse_published's ISO/RFC-
    2822/strptime attempts can't read at all - converted to ISO here rather
    than passed through, or a profile post's date would silently come out as
    `published_precision='unknown'` for every article from that tier."""
    raw = post.get("time") or post.get("date") or post.get("publishedAt")
    if raw:
        return raw
    timestamp = post.get("timestamp")
    if isinstance(timestamp, (int, float)):
        try:
            return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    return timestamp


def _article_from_post(post, source_url, source_name):
    if not isinstance(post, dict):
        return None
    url = _post_url(post)
    text = _post_text(post)
    if not url or not text:
        return None
    author_name = _post_author(post)
    return {
        "url": url,
        "source": "facebook.com",
        "source_url": source_url,
        "source_name": source_name,
        "title": author_name or "Facebook post",
        "author": author_name or None,
        "published": _published_value(post),
        "text": text,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def _articles_from_posts(posts, source_url, source_name):
    return [
        article
        for article in (_article_from_post(post, source_url, source_name) for post in posts)
        if article
    ]


def apify_facebook_page_posts(page_url, source_url, source_name):
    """Recent posts from one Facebook page. Raises ApifyBillingError (see
    apify_common) if the actor can't run for a subscription/credit reason -
    callers should surface that to the user rather than treating it as a
    silent empty result."""
    posts = run_actor_sync(
        config.APIFY_FACEBOOK_PAGES_ACTOR,
        {"startUrls": [{"url": _actor_target_url(page_url)}], "resultsLimit": config.APIFY_FACEBOOK_MAX_POSTS},
        actor_label="Facebook page posts",
        timeout=config.APIFY_FACEBOOK_PAGES_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)


def apify_facebook_group_posts(group_url, source_url, source_name):
    """Recent posts from one Facebook group. Raises ApifyBillingError (see
    apify_common) under the same conditions as apify_facebook_page_posts."""
    posts = run_actor_sync(
        config.APIFY_FACEBOOK_GROUPS_ACTOR,
        {"startUrls": [{"url": _actor_target_url(group_url)}], "resultsLimit": config.APIFY_FACEBOOK_MAX_POSTS},
        actor_label="Facebook group posts",
        timeout=config.APIFY_FACEBOOK_GROUPS_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)


def apify_facebook_profile_posts(profile_url, source_url, source_name):
    """Recent posts from one personal Facebook profile. Raises
    ApifyBillingError (see apify_common) under the same conditions as
    apify_facebook_page_posts.

    The default actor (cleansyntax/facebook-profile-posts-scraper) takes a
    different input shape than the other three - a single `urls_text` blob
    plus an `endpoint` selector, confirmed against a live run - rather than
    the startUrls/resultsLimit shape apify_facebook_page_posts/
    apify_facebook_group_posts use. It also uses its own, smaller
    APIFY_FACEBOOK_PROFILE_MAX_POSTS rather than the shared
    APIFY_FACEBOOK_MAX_POSTS - confirmed live, this actor takes ~55s for 5
    posts but hadn't finished 20 posts even after 270s, so the shared
    default of 20 would starve it under any reasonable timeout."""
    posts = run_actor_sync(
        config.APIFY_FACEBOOK_PROFILE_ACTOR,
        {
            "endpoint": "profile_posts_by_url",
            "urls_text": _actor_target_url(profile_url),
            "max_posts": config.APIFY_FACEBOOK_PROFILE_MAX_POSTS,
        },
        actor_label="Facebook profile posts",
        timeout=config.APIFY_FACEBOOK_PROFILE_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)


def apify_facebook_search_posts(query, source_url, source_name):
    """Posts matching a search query across Facebook.

    The default actor here used to be apify/facebook-search-scraper, which
    turned out - confirmed live - to be a Page *directory* finder (by name/
    category, dataset items are pageName/address/phone/rating listings with
    no post-text field at all), not a post-content search: it could never
    have produced an article. APIFY_FACEBOOK_SEARCH_ACTOR now defaults to
    cleansyntax/facebook-profile-posts-scraper's `search_posts_by_keyword`
    endpoint instead (the same actor apify_facebook_profile_posts uses, in
    its keyword-search mode rather than its profile-posts mode) - confirmed
    live against the exact query that used to return nothing ("cars for sale
    lebanon" now finds real for-sale posts from public groups/profiles
    matching it), same url/message/timestamp/author.name dataset shape
    _article_from_post already normalizes for the profile tier. Much faster
    than the profile-posts endpoint too (~7-9s per query observed, vs. ~55s+
    for a single profile's posts), hence its own default timeout rather than
    reusing APIFY_FACEBOOK_PROFILE_TIMEOUT_SECONDS's larger budget.
    Raises ApifyBillingError (see apify_common) under the same conditions as
    apify_facebook_page_posts."""
    posts = run_actor_sync(
        config.APIFY_FACEBOOK_SEARCH_ACTOR,
        {
            "endpoint": "search_posts_by_keyword",
            "keywords_text": query,
            "max_posts": config.APIFY_FACEBOOK_MAX_POSTS,
        },
        actor_label="Facebook search",
        timeout=config.APIFY_FACEBOOK_SEARCH_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)
