"""Destructive integration tests: TEST_DATABASE_URL must point to a disposable database."""
import os
from unittest.mock import patch

import pytest

pytestmark = pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="Requires disposable Postgres")

@pytest.fixture
def collection():
    from app.core import db, settings
    import migrate
    url = os.environ["TEST_DATABASE_URL"]
    with patch.dict(os.environ, {"DATABASE_URL": url}), patch.object(settings, "DATABASE_URL", url):
        db.close_pool()
        migrate.run_on_startup()
        db.execute("truncate projects, articles, pipeline_runs restart identity cascade")
        a = db.fetch_one("insert into projects (name) values ('A') returning id")["id"]
        b = db.fetch_one("insert into projects (name) values ('B') returning id")["id"]
        ids = [db.fetch_one("insert into articles (url, title) values (%s, 'test') returning id", (url,))["id"] for url in ('https://example.com/a', 'https://example.com/shared', 'https://example.com/b')]
        for article, project in ((ids[0], a), (ids[1], a), (ids[1], b), (ids[2], b)):
            db.execute("insert into article_projects (article_id, project_id) values (%s, %s)", (article, project))
        yield db, a, b, ids
        db.close_pool()


def test_shared_articles_and_other_project_survive(collection):
    from services.articles.store import remove_project_articles, preview_project_article_removal
    db, a, b, ids = collection
    assert preview_project_article_removal(a) == {"linked_articles": 2, "only_in_project": 1, "shared_with_other_projects": 1}
    assert remove_project_articles(a)["articles_deleted"] == 1
    assert db.fetch_one("select id from articles where id = %s", (ids[0],)) is None
    assert db.fetch_one("select count(*) as n from article_projects where project_id = %s", (b,))["n"] == 2
    assert remove_project_articles(a)["articles_removed"] == 0


@pytest.mark.parametrize("global_delete", [False, True])
def test_active_collection_blocks_removal_atomically(collection, global_delete):
    from services.articles.store import remove_project_articles, delete_all_articles, ArticleRemovalConflict
    db, a, b, ids = collection
    # Even another project's collection can write this project's shared sources.
    db.execute("insert into pipeline_runs (id, project_id, status) values ('active', %s, 'running')", (b,))
    with pytest.raises(ArticleRemovalConflict):
        delete_all_articles() if global_delete else remove_project_articles(a)
    assert db.fetch_one("select count(*) as n from articles")["n"] == 3
    assert db.fetch_one("select count(*) as n from article_projects")["n"] == 4


def test_failure_rolls_back_unlink(collection):
    from services.articles import store
    db, a, b, ids = collection
    # A real database constraint rejects the delete after unlinking was attempted.
    db.execute("create table removal_test_reference (article_id bigint references articles(id))")
    try:
        db.execute("insert into removal_test_reference values (%s)", (ids[0],))
        assert store.remove_project_articles(a) is None
        assert db.fetch_one("select count(*) as n from article_projects where project_id = %s", (a,))["n"] == 2
    finally:
        db.execute("drop table removal_test_reference")
