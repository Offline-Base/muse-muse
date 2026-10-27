"""Muse Glimmer client for both backends. See docs/CONTRACTS.md, "Model clients".

openrouter (development, synthetic data only) and llama_server (shipping, on the device) both
speak OpenAI chat completions. The differences are the reasoning field, the LoRA field and the
cloud refusal: on a cloud backend every call must say `synthetic=True` or it is refused.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from base.config import CloudBackendRefused, Settings

REASONING_LEVELS = ("low", "medium", "high", "xhigh")
OPENROUTER_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high"}
TRUNCATION_CAP = 8000
TRIES = 3
BACKOFF_SECONDS = 1.0
DEFAULT_TIMEOUT = 120.0
CONNECT_TIMEOUT = 10.0
LOCAL_TOKENS_PER_SECOND = 5.0  # a slow Jetson; the laptop is faster, and this is only a ceiling
MAX_RETRY_AFTER = 30.0


class LLMError(RuntimeError):
    """A model call failed (HTTP error, bad response)."""


class LLMParseError(LLMError):
    """The model did not return valid JSON after one retry."""


class LLMTruncated(LLMError):
    """The model spent its whole token budget thinking, even after doubling it."""


@dataclass
class ChatResult:
    content: str
    tool_calls: list[dict] = field(default_factory=list)
    reasoning_tokens: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: int = 0
    model: str = ""
    finish_reason: str | None = None
    provider: str | None = None


def response_format(schema: dict, name: str = "result") -> dict:
    """OpenAI strict json_schema response_format.

    `schema` is either a plain JSON schema or a wrapper {"name", "schema", "strict"?}.
    """
    if "schema" in schema and "type" not in schema:
        return {
            "type": "json_schema",
            "json_schema": {
                "name": schema.get("name", name),
                "strict": schema.get("strict", True),
                "schema": schema["schema"],
            },
        }
    return {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}}


def parse_json(text: str | None) -> dict:
    """Parse a JSON object from model text, tolerating a ```json fence. Raises ValueError."""
    raw = (text or "").strip()
    fenced = re.match(r"^```(?:json)?\s*(.*?)\s*```$", raw, re.DOTALL)
    if fenced:
        raw = fenced.group(1)
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return value


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    if response is not None:
        after = response.headers.get("retry-after", "")
        try:
            return min(float(after), MAX_RETRY_AFTER)
        except ValueError:
            pass
    return BACKOFF_SECONDS * (2**attempt)


def _error_message(response: httpx.Response) -> str:
    """A short error string from the server's JSON error, never request content."""
    try:
        err = response.json().get("error")
        message = err.get("message") if isinstance(err, dict) else err
    except Exception:
        message = None
    return str(message or response.reason_phrase)[:200]


def post_json_with_retry(
    client: httpx.Client,
    url: str,
    body: dict,
    headers: dict[str, str],
    *,
    timeout: float | httpx.Timeout,
    sleep: Callable[[float], None] = time.sleep,
    tries: int = TRIES,
    error: type[Exception] = LLMError,
    retry_read_timeout: bool = True,
) -> dict:
    """POST JSON, retrying 429, 5xx and transport errors with exponential backoff.

    With retry_read_timeout=False a read timeout is final: on a local llama-server it means the
    model is still generating, and sending the same request again only queues more work.
    """
    for attempt in range(tries):
        response = None
        try:
            response = client.post(url, json=body, headers=headers, timeout=timeout)
        except httpx.TransportError as exc:
            if attempt == tries - 1 or (not retry_read_timeout and isinstance(exc, httpx.ReadTimeout)):
                raise error(f"request failed after {attempt + 1} tries: {type(exc).__name__}") from exc
        else:
            if response.status_code < 400:
                try:
                    return response.json()
                except ValueError as exc:
                    raise error(f"HTTP {response.status_code} with a body that is not JSON") from exc
            retryable = response.status_code == 429 or response.status_code >= 500
            if not retryable or attempt == tries - 1:
                raise error(f"HTTP {response.status_code}: {_error_message(response)}")
        sleep(_retry_delay(response, attempt))
    raise error("unreachable")  # pragma: no cover


def _truncated(result: ChatResult) -> bool:
    """Cut off mid-thought: the budget ran out before any content or tool call."""
    return result.finish_reason == "length" and not result.content.strip() and not result.tool_calls


def _with_reasoning_line(messages: list[dict], level: str) -> list[dict]:
    """Glimmer reads `Reasoning strength: <level>` from the system prompt (model card)."""
    line = f"Reasoning strength: {level}"
    out = [dict(m) for m in messages]
    if out and out[0].get("role") == "system":
        content = out[0].get("content") or ""
        if isinstance(content, str) and "reasoning strength:" not in content.lower():
            out[0]["content"] = f"{line}\n\n{content}" if content else line
        return out
    return [{"role": "system", "content": line}, *out]


NAMES_SCHEMA = {
    "name": "person_names",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {"names": {"type": "array", "items": {"type": "string"}}},
        "required": ["names"],
        "additionalProperties": False,
    },
}

NAMES_PROMPT = (
    "You find people's names in text. List every name of a person that appears in the text: full "
    "names, first names alone, last names alone and nicknames. Copy each one exactly as written. "
    "Do not list tags in square brackets such as [Student A] or [Teacher], places, schools or book "
    'titles. Reply with JSON only: {"names": [...]}. If there are none, reply {"names": []}.'
)


class LocalLLM:
    """Glimmer through an OpenAI-compatible endpoint. `role` picks the answer or router server."""

    def __init__(
        self,
        settings: Settings,
        role: str = "answer",
        *,
        client: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        if role not in ("answer", "router"):
            raise ValueError(f"role must be answer or router, not {role!r}")
        self.settings = settings
        self.role = role
        self.backend = settings.glimmer_backend
        self.base_url = (settings.answer_url if role == "answer" else settings.router_url).rstrip("/")
        self.model = settings.answer_model if role == "answer" else settings.router_model
        self._client = client
        self._sleep = sleep

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            # trust_env=False: no proxy from the environment or the system settings may sit
            # between this process and the model, because the requests hold raw documents.
            self._client = httpx.Client(trust_env=False)
        return self._client

    def timeout_for(self, max_tokens: int, timeout: float | None) -> httpx.Timeout:
        """The read timeout for one call. llama-server sends nothing until it is done, so on the
        device the timeout grows with the token budget (a Jetson decodes about 5 to 12 tokens a
        second); connecting stays short either way."""
        if timeout is None:
            timeout = DEFAULT_TIMEOUT
            if self.backend == "llama_server":
                timeout = max(DEFAULT_TIMEOUT, max_tokens / LOCAL_TOKENS_PER_SECOND + 60)
        return httpx.Timeout(timeout, connect=min(CONNECT_TIMEOUT, timeout))

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.settings.model_api_key:
            headers["Authorization"] = f"Bearer {self.settings.model_api_key}"
        if self.backend == "openrouter":
            headers["X-Title"] = "muse-privacy"
        return headers

    def build_body(
        self,
        messages: list[dict],
        *,
        max_tokens: int = 2000,
        json_schema: dict | None = None,
        tools: list[dict] | None = None,
        tool_choice: Any = None,
        reasoning: str | None = "low",
        adapter: int | str | None = None,
    ) -> dict:
        """The chat completions request body for this backend."""
        if reasoning is not None and reasoning not in REASONING_LEVELS:
            raise ValueError(f"reasoning must be one of {REASONING_LEVELS}, not {reasoning!r}")
        msgs = _with_reasoning_line(messages, reasoning) if reasoning else [dict(m) for m in messages]
        body: dict[str, Any] = {"model": self.model, "messages": msgs, "max_tokens": max_tokens}
        if self.backend == "openrouter":
            if adapter is not None:
                raise ValueError(
                    "LoRA adapters need GLIMMER_BACKEND=llama_server; OpenRouter cannot load one"
                )
            if reasoning:
                body["reasoning"] = {"effort": OPENROUTER_EFFORT[reasoning]}
        else:
            if reasoning:
                body["chat_template_kwargs"] = {"reasoning_strength": reasoning}
            if adapter is not None:
                try:
                    lora_id = int(adapter)
                except (TypeError, ValueError):
                    raise ValueError(
                        f"adapter must be a llama-server LoRA id (an int), not {adapter!r}"
                    ) from None
                body["lora"] = [{"id": lora_id, "scale": 1.0}]
        if json_schema is not None:
            body["response_format"] = response_format(json_schema)
        if tools:
            body["tools"] = tools
            if tool_choice is not None:
                body["tool_choice"] = tool_choice
        return body

    def chat(
        self,
        messages: list[dict],
        *,
        max_tokens: int = 2000,
        json_schema: dict | None = None,
        tools: list[dict] | None = None,
        tool_choice: Any = None,
        reasoning: str | None = "low",
        adapter: int | str | None = None,
        timeout: float | None = None,
        synthetic: bool = False,
    ) -> ChatResult:
        """One chat completion. On a cloud backend, pass synthetic=True only for invented data.

        A reply cut off mid-thought (finish_reason "length", no content) is retried once with
        double the token budget (capped at 8000), then raises LLMTruncated.
        """
        if self.settings.is_cloud_backend and not synthetic:
            raise CloudBackendRefused(
                f"GLIMMER_BACKEND={self.backend} is a cloud endpoint; only invented data may be sent, "
                "and the caller did not mark this call synthetic."
            )
        start = time.monotonic()

        def call(budget: int) -> ChatResult:
            body = self.build_body(
                messages,
                max_tokens=budget,
                json_schema=json_schema,
                tools=tools,
                tool_choice=tool_choice,
                reasoning=reasoning,
                adapter=adapter,
            )
            data = post_json_with_retry(
                self.client,
                f"{self.base_url}/chat/completions",
                body,
                self.headers(),
                timeout=self.timeout_for(budget, timeout),
                sleep=self._sleep,
                retry_read_timeout=self.backend != "llama_server",
            )
            return self._result(data, start)

        result = call(max_tokens)
        if _truncated(result):
            bigger = min(max_tokens * 2, TRUNCATION_CAP)
            if bigger > max_tokens:
                result = call(bigger)
            if _truncated(result):
                raise LLMTruncated(f"reply hit max_tokens={max(bigger, max_tokens)} before any content")
        return result

    def _result(self, data: dict, start: float) -> ChatResult:
        try:
            choice = data["choices"][0]
            message = choice.get("message") or {}
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError("response has no choices") from exc
        usage = data.get("usage") or {}
        details = usage.get("completion_tokens_details") or {}
        return ChatResult(
            content=message.get("content") or "",
            tool_calls=list(message.get("tool_calls") or []),
            reasoning_tokens=int(details.get("reasoning_tokens") or 0),
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            latency_ms=int((time.monotonic() - start) * 1000),
            model=data.get("model") or self.model,
            finish_reason=choice.get("finish_reason"),
            provider=data.get("provider"),
        )

    def chat_json(self, messages: list[dict], schema: dict, **kw: Any) -> dict:
        """chat() with a strict json_schema; parses the reply, retrying once on bad JSON."""
        result = self.chat(messages, json_schema=schema, **kw)
        try:
            return parse_json(result.content)
        except ValueError:
            pass
        retry = list(messages)
        if result.content.strip():
            retry.append({"role": "assistant", "content": result.content})
        retry.append({"role": "user", "content": "That was not valid JSON. Reply with only the JSON object."})
        if result.finish_reason == "length":
            kw["max_tokens"] = min(kw.get("max_tokens", 2000) * 2, TRUNCATION_CAP)
        result = self.chat(retry, json_schema=schema, **kw)
        try:
            return parse_json(result.content)
        except ValueError as exc:
            raise LLMParseError("model reply was not valid JSON after one retry") from exc

    def health(self, timeout: float = 5) -> bool:
        """llama_server: GET /health on the server root. openrouter: the key check endpoint."""
        try:
            if self.backend == "llama_server":
                root = self.base_url.removesuffix("/v1")
                response = self.client.get(f"{root}/health", headers=self.headers(), timeout=timeout)
            else:
                if not self.settings.model_api_key:
                    return False
                response = self.client.get(f"{self.base_url}/key", headers=self.headers(), timeout=timeout)
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    def llm_names(self, text: str, *, synthetic: bool = False, max_tokens: int = 1500) -> list[str]:
        """The guard's second pass: person names Glimmer finds in `text`.

        Only names that really occur in the text are returned, so a made-up name can never be
        tagged into the output. For guard.tag, pass functools.partial(llm.llm_names, synthetic=True)
        on the cloud backend.
        """
        if not text.strip():
            return []
        data = self.chat_json(
            [{"role": "system", "content": NAMES_PROMPT}, {"role": "user", "content": text}],
            NAMES_SCHEMA,
            max_tokens=max_tokens,
            synthetic=synthetic,
        )
        from base.guard import name_occurs  # lazy: guard does not need this module

        names: list[str] = []
        for value in data.get("names") or []:
            name = str(value).strip()
            # Kept when it occurs in the text, allowing for apostrophe, space and case differences.
            if name and not name.startswith("[") and name not in names and name_occurs(name, text):
                names.append(name)
        return names
