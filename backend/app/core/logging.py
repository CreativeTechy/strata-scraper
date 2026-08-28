"""Root logging setup for the backend process.

Python's root logger has no handlers and defaults to the WARNING threshold
until something configures it, so without this every `logger.info(...)` and
`logger.debug(...)` in the app is silently discarded - the FastAPI process
never calls `logging.basicConfig`/`dictConfig` anywhere. Call
`configure_logging()` once, as early as possible in `main.py`.

The `scrapy crawl` subprocess is unaffected by this: Scrapy configures its
own root logger via `CrawlerProcess`, independently of this module.
"""

from __future__ import annotations

import logging
import logging.config
import os


def configure_logging() -> None:
    level = (os.environ.get("LOG_LEVEL") or "INFO").strip().upper()
    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "default": {
                    "format": "%(asctime)s %(levelname)s [%(name)s] %(message)s",
                },
            },
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "default",
                },
            },
            "root": {
                "handlers": ["console"],
                "level": level,
            },
        }
    )
