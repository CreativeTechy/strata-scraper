"""Streaming collection: a Scrapy item pipeline that validates and saves
each article as soon as the spider yields it, instead of buffering the whole
crawl to a file and processing it in a separate subprocess afterward (see
services/pipeline/pipeline.py, which used to run `scrapy crawl -O raw_file`
then a second pass over that file). This is what lets the dashboard show a
source's results while other sources are still being crawled, instead of
waiting for the slowest source in the run.

Reuses services/articles/collect.py's exact per-article logic (validate,
dedup, date-window filter, skip-if-already-stored, persist per-source
stats) rather than duplicating it - collect.py itself stays as the
batch/manual CLI entry point (`scrapy crawl -O articles.json` then
`python -m services.articles.collect`, still documented for offline/dev
use), now sharing this file's logic instead of diverging from it.

Only active for backend-triggered runs (PIPELINE_RUN_ID set - see
from_crawler below); a bare manual `scrapy crawl source_rss -O out.json` has
no run to stream progress into, so this pipeline is a no-op there and the
manual collect step afterward is unaffected.

Synchronous, unlike strata-media's equivalent: with no LLM/embedding call
in this app there is no multi-second blocking work left to overlap, only
short local-Postgres round trips (the already-stored lookup, the upsert,
and the progress writes). Those cost far less than the network fetches the
crawl is really bound by - and less than the spider's own blocking lookups
(tweet hydration, Google News link decoding, GDELT) - so processing items
on the reactor thread is not worth a worker pool and the lock/counter
bookkeeping that comes with one.
"""

from collections import Counter, defaultdict

from scrapy.exceptions import NotConfigured

from app.core import settings as config
from services.articles import collect
from services.articles.store import get_existing_urls, save_articles
from services.pipeline.pipeline_runs import update_pipeline_run


class StreamingCollectPipeline:
    @classmethod
    def from_crawler(cls, crawler):
        if not collect.PIPELINE_RUN_ID:
            # Manual/dev crawl (no backend-triggered run to stream progress
            # into) - stay out of the way entirely; collect.py's file-based
            # CLI workflow still works unchanged.
            raise NotConfigured("StreamingCollectPipeline only runs for backend-triggered pipeline runs.")
        return cls()

    def open_spider(self, spider):
        self.project = collect._load_project()
        self.seen_urls = set()
        self.scraped_by_source = Counter()
        self.removed_by_source = defaultdict(lambda: {"duplicate": 0, "blocked": 0})
        self.date_filtered_by_source = Counter()
        self.skipped_existing_by_source = Counter()
        self.kept_by_source = Counter()
        self.saved_by_source = Counter()
        self.articles_cleaned_total = 0
        self.articles_saved_total = 0

    def process_item(self, item, spider):
        article = dict(item)
        source = collect._source_key(article)

        self.scraped_by_source[source] += 1
        cleaned, removed = collect.clean_articles([article], seen_urls=self.seen_urls)
        for reason, count in (removed.get(source) or {}).items():
            self.removed_by_source[source][reason] += count
        if not cleaned:
            self._push_progress()
            return article
        article = cleaned[0]

        if self.project and not collect._article_matches_project_window(article, self.project):
            self.date_filtered_by_source[source] += 1
            self._push_progress()
            return article

        # Counted before the already-stored check below, so "kept" means
        # "passed validation and the date window" regardless of whether an
        # earlier run already stored this URL - see collect.py's main() for
        # the matching order in the batch path.
        self.kept_by_source[source] += 1
        self.articles_cleaned_total += 1

        if config.SKIP_EXISTING_URLS and get_existing_urls([article["url"]]):
            self.skipped_existing_by_source[source] += 1
            self._push_progress()
            return article

        saved_count, saved_delta = save_articles([collect.mark_unanalyzed(article)])
        self.articles_saved_total += saved_count
        for saved_source, count in (saved_delta or {}).items():
            self.saved_by_source[saved_source] += count

        self._push_progress()
        return article

    def _push_progress(self):
        # articles_scraped/crawl_pages/message/stage are owned by the spider
        # itself (source_rss.py's own _push_progress) - this only ever
        # touches the columns it's responsible for, so the two don't
        # overwrite each other's fields on the same pipeline_runs row.
        update_pipeline_run(
            collect.PIPELINE_RUN_ID,
            articles_cleaned=self.articles_cleaned_total,
            articles_saved=self.articles_saved_total,
        )
        collect._persist_source_stats(
            self.scraped_by_source,
            {source: dict(counts) for source, counts in self.removed_by_source.items()},
            self.date_filtered_by_source,
            self.skipped_existing_by_source,
            self.kept_by_source,
            self.saved_by_source,
        )

    def close_spider(self, spider):
        self._push_progress()
