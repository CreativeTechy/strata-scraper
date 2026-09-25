from unittest.mock import patch

import pytest
from fastapi import HTTPException
from api.routers import articles as routes
from services.articles.store import ArticleRemovalConflict

USER = {"id": 3, "username": "editor"}

@pytest.fixture(autouse=True)
def project():
    with patch.object(routes, "ensure_project_visible"), patch.object(routes, "get_project", return_value={"id": 7, "name": "Project A"}), patch.object(routes, "get_active_run_for_project", return_value=None):
        yield


def test_confirmation_is_checked_by_server():
    with patch("services.articles.store.remove_project_articles") as remove:
        with pytest.raises(HTTPException) as exc:
            routes.remove_project_articles_route(7, {"confirm": "project a"}, USER)
        assert exc.value.status_code == 400
        remove.assert_not_called()


def test_removal_returns_counts_and_actor():
    with patch("services.articles.store.remove_project_articles", return_value={"articles_removed": 2}) as remove:
        assert routes.remove_project_articles_route(7, {"confirm": "Project A"}, USER) == {"ok": True, "articles_removed": 2}
        remove.assert_called_once_with(7, actor="editor")


def test_active_run_found_during_transaction_is_conflict():
    with patch("services.articles.store.remove_project_articles", side_effect=ArticleRemovalConflict("Run active")):
        with pytest.raises(HTTPException) as exc:
            routes.remove_project_articles_route(7, {"confirm": "Project A"}, USER)
        assert exc.value.status_code == 409


def test_inaccessible_project_never_reaches_removal():
    with patch.object(routes, "ensure_project_visible", side_effect=HTTPException(404)), patch("services.articles.store.remove_project_articles") as remove:
        with pytest.raises(HTTPException) as exc:
            routes.remove_project_articles_route(7, {"confirm": "Project A"}, USER)
        assert exc.value.status_code == 404
        remove.assert_not_called()


def test_global_removal_is_admin_only():
    with patch.object(routes.permissions_store, "user_is_full_access", return_value=False), patch("services.articles.store.delete_all_articles") as remove:
        with pytest.raises(HTTPException) as exc:
            routes.delete_articles("DELETE ALL ARTICLES", USER)
        assert exc.value.status_code == 403
        remove.assert_not_called()


def test_global_removal_requires_confirmation():
    with patch.object(routes.permissions_store, "user_is_full_access", return_value=True), patch("services.articles.store.delete_all_articles") as remove:
        with pytest.raises(HTTPException) as exc:
            routes.delete_articles("", USER)
        assert exc.value.status_code == 400
        remove.assert_not_called()
