import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from app.core import settings as config
import llm_client


class TimeoutFloorTests(unittest.TestCase):
    """A call site's own timeout is a minimum, not a ceiling - one env var has
    to be able to raise every chat_completion() in the codebase for a slow
    backend."""

    def test_env_floor_raises_a_call_sites_shorter_timeout(self):
        with patch.object(config, "LLM_REQUEST_TIMEOUT_SECONDS", 300):
            self.assertEqual(llm_client._resolve_timeout(90), 300)

    def test_a_call_site_asking_for_longer_than_the_floor_keeps_its_own_budget(self):
        with patch.object(config, "LLM_REQUEST_TIMEOUT_SECONDS", 60):
            self.assertEqual(llm_client._resolve_timeout(120), 120)

    def test_no_per_call_timeout_falls_back_to_the_floor(self):
        with patch.object(config, "LLM_REQUEST_TIMEOUT_SECONDS", 45):
            self.assertEqual(llm_client._resolve_timeout(None), 45)


class ColdStartRetryTests(unittest.TestCase):
    """A serverless backend spends the first request after an idle period
    booting a worker, so the request that pays for the boot is the one that
    times out."""

    def test_timeout_is_retried_once_with_the_cold_start_budget(self):
        timeouts = []

        def fake_post(url, body, timeout, *, api_key):
            timeouts.append(timeout)
            if len(timeouts) == 1:
                raise llm_client.LLMTimeoutError("read timed out")
            return {"ok": True}

        with patch.object(config, "LLM_COLD_START_TIMEOUT_SECONDS", 300), \
             patch.object(llm_client, "_post", side_effect=fake_post):
            payload = llm_client._post_with_cold_start_retry(
                "http://x", {}, 90, api_key="k"
            )

        self.assertEqual(payload, {"ok": True})
        self.assertEqual(timeouts, [90, 300])

    def test_retry_is_off_by_default_so_warm_providers_fail_fast(self):
        with patch.object(config, "LLM_COLD_START_TIMEOUT_SECONDS", 0), \
             patch.object(llm_client, "_post",
                          side_effect=llm_client.LLMTimeoutError("read timed out")) as post:
            with self.assertRaises(llm_client.LLMTimeoutError):
                llm_client._post_with_cold_start_retry("http://x", {}, 90, api_key="k")
        self.assertEqual(post.call_count, 1)

    def test_a_cold_start_budget_below_the_first_attempt_is_not_a_retry(self):
        with patch.object(config, "LLM_COLD_START_TIMEOUT_SECONDS", 60), \
             patch.object(llm_client, "_post",
                          side_effect=llm_client.LLMTimeoutError("read timed out")) as post:
            with self.assertRaises(llm_client.LLMTimeoutError):
                llm_client._post_with_cold_start_retry("http://x", {}, 90, api_key="k")
        self.assertEqual(post.call_count, 1)

    def test_a_non_timeout_failure_is_not_retried(self):
        with patch.object(config, "LLM_COLD_START_TIMEOUT_SECONDS", 300), \
             patch.object(llm_client, "_post",
                          side_effect=llm_client.LLMAuthError("401")) as post:
            with self.assertRaises(llm_client.LLMAuthError):
                llm_client._post_with_cold_start_retry("http://x", {}, 90, api_key="k")
        self.assertEqual(post.call_count, 1)


class ReasoningBlockStrippingTests(unittest.TestCase):
    """Qwen3-style models write their reasoning into `content` itself, so the
    JSON every caller here asks for arrives behind a <think> preamble."""

    def _extract(self, content, finish_reason="stop"):
        return llm_client._extract_output_text_chat_completions(
            {"choices": [{"finish_reason": finish_reason,
                          "message": {"content": content}}]}
        )

    def test_json_behind_a_think_block_is_returned_alone(self):
        self.assertEqual(
            self._extract('<think>\nWeighing the options.\n</think>\n{"industry": "telematics"}'),
            '{"industry": "telematics"}',
        )

    def test_closing_tag_with_trailing_whitespace_is_still_matched(self):
        self.assertEqual(self._extract("<think>hmm</think   >\n{}"), "{}")

    def test_content_with_no_think_block_is_untouched(self):
        self.assertEqual(self._extract('{"industry": "telematics"}'),
                         '{"industry": "telematics"}')

    def test_an_unclosed_think_block_reads_as_empty_not_as_an_answer(self):
        # The budget ran out mid-thought: there is no answer after the tag, and
        # returning the reasoning text would hand the caller unparseable JSON.
        with self.assertRaises(llm_client.LLMInvalidResponseError):
            self._extract("<think>\nStill reasoning when the budget ran out")

    def test_reasoning_wrapped_around_the_answer_leaves_only_the_answer(self):
        self.assertEqual(self._extract("<think>a</think>{}<think>b</think>"), "{}")


class DisableThinkingTests(unittest.TestCase):
    def _body(self):
        return llm_client._build_request_body(
            messages=[{"role": "user", "content": "hi"}],
            model="Qwen/Qwen3-8B", temperature=0.1, max_tokens=1400,
            json_mode=False, api_style="chat_completions", reasoning_effort=None,
        )

    def test_off_by_default_so_existing_providers_see_an_unchanged_body(self):
        with patch.object(config, "LLM_DISABLE_THINKING", False):
            self.assertNotIn("chat_template_kwargs", self._body())

    def test_sends_the_vllm_chat_template_flag_when_enabled(self):
        with patch.object(config, "LLM_DISABLE_THINKING", True):
            self.assertEqual(self._body()["chat_template_kwargs"],
                             {"enable_thinking": False})


if __name__ == "__main__":
    unittest.main()
