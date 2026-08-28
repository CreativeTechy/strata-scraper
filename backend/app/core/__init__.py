"""Cross-cutting infrastructure imported by every other layer: settings, the
DB pool, logging setup, and the in-process job registry. Imports no feature
code (services/, scraper/) - see CLAUDE.md's Architecture section.
"""
