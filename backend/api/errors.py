"""Domain error hierarchy for the HTTP layer, modelled on llm_client.py's
LLMError - the one place in this codebase that already gets this right: a
stable status for the generic handler in main.py to map, a message safe to
show the user, and an optional detail for extra context.

Generalizes that pattern to the rest of the API, replacing the endpoints that
used to return HTTP 200 with an {"error": ...} body instead of a real status
code - the "two incompatible error protocols in one API" gap the
architecture review called out: a monitor watching status codes could not
see a failed project/source create, an invalid payload, or a failed delete,
because all of them answered 200.
"""

from __future__ import annotations


class AppError(Exception):
    """Base for every domain error raised from a route. Caught by main.py's
    generic AppError handler, which shapes it as {"error": ..., "detail": ...}
    at `status_code` - the same body shape _http_exception_handler already
    gives a raised HTTPException, so the dashboard's formatApiError() needs
    no special-casing for either."""

    status_code = 500

    def __init__(self, message: str, *, detail: str | None = None):
        super().__init__(message)
        self.message = message
        self.detail = detail


class ValidationError(AppError):
    """The request itself is invalid - a 400."""

    status_code = 400


class NotFoundError(AppError):
    """The referenced resource does not exist, or isn't visible to this
    user - a 404."""

    status_code = 404


class ConflictError(AppError):
    """The operation could not complete against current state (a failed
    create/update/delete, usually because storage rejected it) - a 409."""

    status_code = 409
