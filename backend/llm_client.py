"""Thin client for the configured chat LLM provider (OpenAI, DeepSeek, or Ollama).

`config.LLM_PROVIDER` picks the app-wide active provider; this module is the
only place that knows the difference between OpenAI's Responses API and the
OpenAI-compatible chat-completions shape DeepSeek/Ollama (and similar
providers) use. Every caller goes through the single `chat_completion(...)`
entry point below and never sees which provider or API shape actually served
the request - unless it passes an explicit provider override (see
`chat_completion`'s docstring), a caller gets whatever `config.LLM_*`
currently resolves to.
"""

from __future__ import annotations

import re

import requests

from app.core import settings as config


class LLMError(Exception):
    """Base class for user-facing LLM failures.

    Carries a stable, machine-readable `code` and a short, provider-neutral
    `user_message` safe to show in the UI. `detail` holds the raw
    provider/exception text for server-side logs only - never send it to
    the client.
    """

    code = "llm_provider_error"
    user_message = "The assistant hit an unexpected error. Please try again."

    def __init__(self, detail="", *, code=None, user_message=None):
        super().__init__(detail or self.user_message)
        self.detail = detail
        if code is not None:
            self.code = code
        if user_message is not None:
            self.user_message = user_message


class LLMConfigError(LLMError):
    code = "llm_config_error"
    user_message = "The AI assistant isn't set up yet. Please contact your administrator."


class LLMAuthError(LLMError):
    code = "llm_auth_error"
    user_message = "The AI assistant isn't configured correctly. Please contact your administrator."


class LLMRateLimitError(LLMError):
    code = "llm_rate_limited"
    user_message = "The assistant is busy right now. Please wait a moment and try again."


class LLMQuotaError(LLMError):
    code = "llm_quota_exceeded"
    user_message = "The AI provider account is out of credit or has hit its usage quota. Top up billing for the configured provider and try again."


class LLMTimeoutError(LLMError):
    code = "llm_timeout"
    user_message = "The assistant took too long to respond. Please try again."


class LLMUnavailableError(LLMError):
    code = "llm_unavailable"
    user_message = "The assistant service is temporarily unavailable. Please try again shortly."


class LLMConnectionError(LLMError):
    code = "llm_connection_error"
    user_message = (
        "Couldn't reach the configured LLM endpoint at all (connection failed). "
        "Check that the service is running and reachable, and that "
        "LLM_CHAT_BASE_URL/OLLAMA_CHAT_BASE_URL points at the right host - this "
        "is also what happens when a tunnel (e.g. ngrok) in front of it has gone offline."
    )


class LLMEndpointNotFoundError(LLMError):
    code = "llm_endpoint_not_found"
    user_message = (
        "The configured LLM endpoint returned 404 Not Found. Every call uses the "
        "same URL, so this means the endpoint itself is wrong or gone - not a "
        "problem with one article. Check LLM_CHAT_BASE_URL/OLLAMA_CHAT_BASE_URL, "
        "and that a tunnel in front of it (e.g. ngrok) hasn't gone offline."
    )


class LLMBadRequestError(LLMError):
    code = "llm_bad_request"
    user_message = "That request couldn't be processed. Try rephrasing your question."


class LLMInvalidResponseError(LLMError):
    code = "llm_invalid_response"
    user_message = "The assistant couldn't produce a usable answer. Try rephrasing your question."

    def __init__(self, detail="", *, code=None, user_message=None, finish_reason=None):
        super().__init__(detail, code=code, user_message=user_message)
        self.finish_reason = finish_reason


def _split_instructions(messages):
    """Split chat-style messages into Responses `instructions` + `input`.

    The Responses API has no "system" role in `input`; system/developer
    messages become the top-level `instructions` string instead, in the
    order they appeared. Everything else is passed through as-is - the
    Responses API accepts the same simple {"role", "content"} shape chat
    completions used for user/assistant turns.
    """
    instructions_parts = []
    input_items = []
    for message in messages:
        role = message.get("role")
        content = message.get("content")
        if role in ("system", "developer"):
            if content:
                instructions_parts.append(content)
        else:
            input_items.append({"role": role, "content": content})
    instructions = "\n\n".join(instructions_parts) if instructions_parts else None
    return instructions, input_items


def _extract_output_text_responses(payload) -> str:
    """Extract text from an OpenAI Responses API payload."""
    status = payload.get("status", "unknown")
    output = payload.get("output") or []

    texts = []
    refusal = None
    for item in output:
        if item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            content_type = content.get("type")
            if content_type == "output_text":
                text = content.get("text")
                if text:
                    texts.append(text)
            elif content_type == "refusal":
                refusal = content.get("refusal")

    joined = "\n".join(text.strip() for text in texts if text and text.strip()).strip()
    incomplete_reason = (payload.get("incomplete_details") or {}).get("reason", "unknown")

    # A response cut off by the token budget is unusable even when some text
    # did make it out - a JSON payload chopped mid-object is not valid JSON,
    # so treat it the same as a fully empty response and let the caller's
    # retry-with-more-budget logic kick in.
    if joined and incomplete_reason != "max_output_tokens":
        return joined

    # The provider accepted the request (2xx) but sent back nothing usable -
    # a refusal, a response cut short by the token budget, or a
    # reasoning model burning its whole budget on hidden reasoning before it
    # could write any visible content all look like this. Surface the
    # incomplete reason/refusal so the caller's log line says *why*, and so
    # it can pick a retry strategy.
    if refusal:
        raise LLMInvalidResponseError(
            f"LLM refused the request (status={status}): {refusal}",
            finish_reason=incomplete_reason,
        )
    raise LLMInvalidResponseError(
        f"LLM returned {'a truncated' if joined else 'an empty'} response "
        f"(status={status}, incomplete_reason={incomplete_reason})",
        finish_reason=incomplete_reason,
    )


_THINK_BLOCK_RE = re.compile(r"<think[^>]*>.*?</think[^>]*>", re.DOTALL | re.IGNORECASE)


def _strip_reasoning_block(text: str) -> str:
    """Drop a hybrid-reasoning model's <think> block from its visible content.

    Qwen3 and similar models emit their reasoning inline in `content` rather
    than in a separate field, so the JSON every caller here asks for arrives
    behind a <think>...</think> preamble and fails to parse. Providers that
    split reasoning into its own field are unaffected: there is no tag to
    match.
    """
    stripped = _THINK_BLOCK_RE.sub("", text).strip()
    # An opening tag with no closing one means the budget ran out mid-thought,
    # so there is no answer after it to keep. Report empty and let the
    # caller's retry-with-more-room path handle it.
    if stripped[:6].lower() == "<think":
        return ""
    return stripped


def _extract_output_text_chat_completions(payload) -> str:
    """Extract text from an OpenAI-compatible chat-completions payload (DeepSeek et al.)."""
    choices = payload.get("choices") or []
    if not choices:
        raise LLMInvalidResponseError("LLM returned no choices", finish_reason="unknown")

    choice = choices[0]
    finish_reason = choice.get("finish_reason") or "unknown"
    message = choice.get("message") or {}
    text = _strip_reasoning_block(message.get("content") or "")

    # Normalize to the same finish_reason vocabulary _post()'s retry logic
    # already understands for the Responses API ("max_output_tokens" means
    # "give it more room and retry").
    normalized_reason = "max_output_tokens" if finish_reason == "length" else finish_reason

    # A response cut off by the token budget is unusable even when some text
    # did make it out - a JSON payload chopped mid-object is not valid JSON,
    # so treat it the same as a fully empty response and let the caller's
    # retry-with-more-budget logic kick in.
    if text and finish_reason != "length":
        return text

    raise LLMInvalidResponseError(
        f"LLM returned {'a truncated' if text else 'an empty'} response (finish_reason={finish_reason})",
        finish_reason=normalized_reason,
    )


def _extract_output_text(payload, *, api_style) -> str:
    if api_style == "chat_completions":
        return _extract_output_text_chat_completions(payload)
    return _extract_output_text_responses(payload)


def _error_message(resp) -> str:
    try:
        detail = (resp.json().get("error") or {}).get("message", "")
    except ValueError:
        detail = ""
    return detail or (resp.text or "")[:500]


def _raise_for_status(resp):
    message = _error_message(resp)
    detail = f"{resp.status_code} error for url: {resp.url} - {message}"
    status = resp.status_code
    if status in (401, 403):
        raise LLMAuthError(detail)
    if status == 402:
        raise LLMQuotaError(detail)
    if status == 404:
        raise LLMEndpointNotFoundError(detail)
    if status == 429:
        raise LLMRateLimitError(detail)
    if status in (400, 422):
        raise LLMBadRequestError(detail)
    if status >= 500:
        raise LLMUnavailableError(detail)
    raise LLMError(detail)


def _resolve_timeout(requested) -> int:
    """Per-call budget, but never below the configured floor.

    Call sites hardcode a timeout sized for the work they ask for against a
    fast hosted API. `LLM_REQUEST_TIMEOUT_SECONDS` raises all of them at once
    for a slower backend, so a caller's own number acts as a minimum rather
    than a ceiling.
    """
    floor = config.LLM_REQUEST_TIMEOUT_SECONDS
    if requested is None:
        return floor
    return max(int(requested), floor)


def _post_with_cold_start_retry(url, body, timeout, *, api_key):
    """POST, retrying a timeout once on the assumption the backend was cold.

    A serverless backend spends the first request after an idle period booting
    a worker and loading weights, so the request that pays for the boot is
    usually the one that times out. Retrying it with a longer budget lands on
    the now-warm worker. Any other failure is not a cold start and is raised
    immediately.
    """
    try:
        return _post(url, body, timeout, api_key=api_key)
    except LLMTimeoutError:
        cold_timeout = config.LLM_COLD_START_TIMEOUT_SECONDS
        if cold_timeout <= timeout:
            raise
        print(
            f"llm_client: timed out after {timeout}s; the backend was likely "
            f"cold-starting - retrying once with timeout={cold_timeout}s"
        )
        return _post(url, body, cold_timeout, api_key=api_key)


def _post(url, body, timeout, *, api_key):
    try:
        resp = requests.post(
            url,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            json=body,
            timeout=timeout,
        )
    except requests.Timeout as exc:
        raise LLMTimeoutError(str(exc)) from exc
    except requests.ConnectionError as exc:
        raise LLMConnectionError(str(exc)) from exc
    except requests.RequestException as exc:
        raise LLMUnavailableError(str(exc)) from exc

    if not resp.ok:
        _raise_for_status(resp)

    try:
        payload = resp.json()
    except ValueError as exc:
        raise LLMInvalidResponseError(f"Non-JSON response from LLM: {exc}") from exc

    # The Responses API can return 2xx with status="failed" (e.g. a
    # provider-side error surfaced mid-request) - treat that the same as an
    # HTTP error rather than trying to extract text from it.
    if payload.get("status") == "failed":
        error = payload.get("error") or {}
        raise LLMError(f"LLM response failed: {error.get('message') or error}")

    return payload


def _build_request_body(*, messages, model, temperature, max_tokens, json_mode, api_style, reasoning_effort):
    """Build the provider-appropriate request body for the same logical inputs.

    This is the one place that adapts to the active provider's payload shape
    - callers always pass the same messages/temperature/max_tokens/timeout
    regardless of which provider is configured.
    """
    if api_style == "chat_completions":
        body = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        if config.LLM_DISABLE_THINKING:
            # vLLM passes chat_template_kwargs through to the model's chat
            # template, which is where Qwen3-style models decide whether to
            # open a <think> block. Turning it off is the difference between
            # spending a 1400-token budget on reasoning and spending it on the
            # JSON the caller asked for. A backend whose template ignores the
            # key is unaffected. See config.LLM_DISABLE_THINKING.
            body["chat_template_kwargs"] = {"enable_thinking": False}
        return body

    # "responses" style (OpenAI Responses API): no system role in `input`,
    # system/developer messages become the top-level `instructions` string.
    instructions, input_items = _split_instructions(messages)
    body = {
        "model": model,
        "input": input_items,
        "temperature": temperature,
        "max_output_tokens": max_tokens,
    }
    if instructions:
        body["instructions"] = instructions
    if json_mode:
        body["text"] = {"format": {"type": "json_object"}}
    if reasoning_effort:
        # Reasoning models (e.g. gpt-5-nano) spend part of max_output_tokens on
        # hidden reasoning before writing visible output - left at OpenAI's
        # default effort, that can consume the whole budget and return nothing
        # visible. See config.OPENAI_REASONING_EFFORT.
        body["reasoning"] = {"effort": reasoning_effort}
    return body


def _max_tokens_key(api_style):
    return "max_tokens" if api_style == "chat_completions" else "max_output_tokens"


def chat_completion(*, messages, model=None, temperature=0.2, max_tokens=512, timeout=None, json_mode=False,
                     api_key=None, base_url=None, api_style=None, reasoning_effort=None, api_key_env_name=None):
    """Send a chat request to the active provider and return its text reply.

    `json_mode=True` asks the provider to constrain its output to a single
    JSON object (OpenAI's/DeepSeek's native JSON-object response format).
    This only forces well-formed JSON syntax, not a particular shape -
    callers still need to validate the result against their own schema.

    `api_key`/`base_url`/`api_style`/`reasoning_effort`/`api_key_env_name`
    default to the app-wide `config.LLM_*` values when omitted. Pass them
    together to route just this call through a different provider without
    touching the provider every other caller uses - also pass a matching
    `model` in that case, since `model`'s own default below is the app-wide
    one too.
    """
    api_key = config.LLM_API_KEY if api_key is None else api_key
    base_url = ((config.LLM_CHAT_BASE_URL if base_url is None else base_url) or "").strip()
    api_style = config.LLM_API_STYLE if api_style is None else api_style
    timeout = _resolve_timeout(timeout)
    reasoning_effort = config.LLM_REASONING_EFFORT if reasoning_effort is None else reasoning_effort
    api_key_env_name = config.LLM_API_KEY_ENV_NAME if api_key_env_name is None else api_key_env_name

    if not api_key or not base_url:
        raise LLMConfigError(f"{api_key_env_name} is not configured")

    body = _build_request_body(
        messages=messages,
        model=model or config.LLM_CHAT_MODEL,
        temperature=temperature,
        max_tokens=max_tokens,
        json_mode=json_mode,
        api_style=api_style,
        reasoning_effort=reasoning_effort,
    )

    try:
        payload = _post_with_cold_start_retry(base_url, body, timeout, api_key=api_key)
    except LLMBadRequestError as exc:
        # Some models only accept the default temperature (1) and reject any
        # other value - drop it and retry once rather than failing outright.
        if "temperature" in (exc.detail or "").lower():
            body = {k: v for k, v in body.items() if k != "temperature"}
            payload = _post_with_cold_start_retry(base_url, body, timeout, api_key=api_key)
        else:
            raise

    max_tokens_key = _max_tokens_key(api_style)
    retry_body = body
    # A non-truncation failure (stray refusal turn) only ever gets one retry
    # with the same request - a second refusal is treated as final. A
    # truncation failure gets repeated doubling instead: a reasoning model
    # that burns its whole budget on hidden thinking can need several
    # doublings before enough room is left over to write visible output, and
    # giving up after a single double (as this used to) left genuinely
    # heavy-reasoning models unable to ever complete a call.
    for attempt in range(4):
        try:
            return _extract_output_text(payload, api_style=api_style)
        except LLMInvalidResponseError as exc:
            if attempt == 3:
                raise
            if exc.finish_reason == "max_output_tokens":
                current = int(retry_body.get(max_tokens_key) or max_tokens)
                if current >= 16000:
                    raise
                retry_body = {**retry_body, max_tokens_key: min(current * 2, 16000)}
                print(
                    f"llm_client: empty response from truncation ({exc.detail}); "
                    f"retrying with {max_tokens_key}={retry_body[max_tokens_key]}"
                )
            elif attempt == 0:
                print(f"llm_client: empty/invalid response ({exc.detail}); retrying once")
            else:
                raise
            payload = _post_with_cold_start_retry(base_url, retry_body, timeout, api_key=api_key)
