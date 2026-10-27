import json
import os

import httpx
import pytest
import respx

from base.config import CloudBackendRefused, load_settings
from base.local_llm import ChatResult, LLMError, LLMParseError, LLMTruncated, LocalLLM

SCHEMA = {
    "type": "object",
    "properties": {"decision": {"type": "string"}},
    "required": ["decision"],
    "additionalProperties": False,
}


def reply(content=None, *, finish="stop", tool_calls=None, reasoning_tokens=7, model="meta/muse-glimmer-30b"):
    message = {"role": "assistant", "content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    return {
        "id": "gen-1",
        "model": model,
        "provider": "SomeProvider",
        "choices": [{"index": 0, "finish_reason": finish, "message": message}],
        "usage": {
            "prompt_tokens": 40,
            "completion_tokens": 12,
            "completion_tokens_details": {"reasoning_tokens": reasoning_tokens},
        },
    }


def body_of(call):
    return json.loads(call.request.content)


@pytest.fixture
def llama(tmp_path):
    return load_settings(
        {
            "BASE_HOME": str(tmp_path / "home"),
            "BASE_DEVICE": "laptop",
            "GLIMMER_BACKEND": "llama_server",
            "ANSWER_URL": "http://127.0.0.1:8081/v1",
            "ROUTER_URL": "http://127.0.0.1:8082/v1",
            "LLAMA_API_KEY": "",
        }
    )


@pytest.fixture
def sleeps():
    return []


def make(settings, sleeps, role="answer"):
    return LocalLLM(settings, role, sleep=sleeps.append)


@respx.mock
def test_openrouter_request_body_and_headers(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        return_value=httpx.Response(200, json=reply("hello"))
    )
    llm = make(settings, sleeps)
    result = llm.chat(
        [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Hi"}],
        max_tokens=1500,
        json_schema=SCHEMA,
        reasoning="medium",
        synthetic=True,
    )
    assert isinstance(result, ChatResult)
    assert result.content == "hello"
    assert (result.prompt_tokens, result.completion_tokens, result.reasoning_tokens) == (40, 12, 7)
    assert result.model == "meta/muse-glimmer-30b" and result.provider == "SomeProvider"
    request = route.calls.last.request
    assert request.headers["authorization"] == "Bearer test-key"
    assert request.headers["x-title"] == "muse-privacy"
    body = body_of(route.calls.last)
    assert body["model"] == settings.answer_model
    assert body["max_tokens"] == 1500
    assert body["reasoning"] == {"effort": "medium"}
    assert "chat_template_kwargs" not in body and "lora" not in body
    assert body["messages"][0]["content"].startswith("Reasoning strength: medium\n\nBe brief.")
    assert body["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "result", "strict": True, "schema": SCHEMA},
    }


@respx.mock
def test_llama_server_body_reasoning_and_adapter(llama, sleeps):
    route = respx.post("http://127.0.0.1:8081/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=reply("ok", model="glimmer"))
    )
    llm = make(llama, sleeps)
    llm.chat([{"role": "user", "content": "Hi"}], reasoning="low", adapter="2")
    body = body_of(route.calls.last)
    assert body["chat_template_kwargs"] == {"reasoning_strength": "low"}
    assert body["lora"] == [{"id": 2, "scale": 1.0}]
    assert "reasoning" not in body
    assert body["messages"][0] == {"role": "system", "content": "Reasoning strength: low"}
    assert "authorization" not in route.calls.last.request.headers
    assert "x-title" not in route.calls.last.request.headers


@respx.mock
def test_router_role_uses_router_server(llama, sleeps):
    route = respx.post("http://127.0.0.1:8082/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=reply("ok"))
    )
    make(llama, sleeps, role="router").chat([{"role": "user", "content": "Hi"}])
    assert route.called


def test_adapter_needs_llama_server(settings, sleeps):
    with pytest.raises(ValueError):
        make(settings, sleeps).build_body([{"role": "user", "content": "x"}], adapter=1)
    with pytest.raises(ValueError):
        make(settings, sleeps).build_body([{"role": "user", "content": "x"}], reasoning="none")


def test_existing_reasoning_line_is_kept(settings, sleeps):
    msgs = [{"role": "system", "content": "Reasoning strength: high\nRoute it."}]
    body = make(settings, sleeps).build_body(msgs, reasoning="low")
    assert body["messages"][0]["content"] == "Reasoning strength: high\nRoute it."
    assert msgs[0]["content"] == "Reasoning strength: high\nRoute it."


@respx.mock
def test_tools_and_null_content(settings, sleeps):
    calls = [{"id": "c1", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}]
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        return_value=httpx.Response(200, json=reply(None, finish="tool_calls", tool_calls=calls))
    )
    tools = [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}]
    result = make(settings, sleeps).chat(
        [{"role": "user", "content": "x"}], tools=tools, tool_choice="auto", synthetic=True
    )
    assert result.content == "" and result.tool_calls == calls
    body = body_of(route.calls.last)
    assert body["tools"] == tools and body["tool_choice"] == "auto"


def test_cloud_backend_refuses_without_synthetic(settings, sleeps):
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(f"{settings.answer_url}/chat/completions").mock(
            return_value=httpx.Response(200, json=reply("x"))
        )
        llm = make(settings, sleeps)
        with pytest.raises(CloudBackendRefused):
            llm.chat([{"role": "user", "content": "x"}])
        with pytest.raises(CloudBackendRefused):
            llm.chat_json([{"role": "user", "content": "x"}], SCHEMA)
        with pytest.raises(CloudBackendRefused):
            llm.llm_names("Some text with a name")
        assert not route.called


@respx.mock
def test_local_backend_needs_no_synthetic_flag(llama, sleeps):
    respx.post("http://127.0.0.1:8081/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=reply("ok"))
    )
    assert make(llama, sleeps).chat([{"role": "user", "content": "x"}]).content == "ok"


@respx.mock
def test_chat_json_retries_once_on_bad_json(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        side_effect=[
            httpx.Response(200, json=reply("not json at all")),
            httpx.Response(200, json=reply('```json\n{"decision": "refuse"}\n```')),
        ]
    )
    data = make(settings, sleeps).chat_json([{"role": "user", "content": "x"}], SCHEMA, synthetic=True)
    assert data == {"decision": "refuse"}
    assert route.call_count == 2
    retry = body_of(route.calls[1])["messages"]
    assert retry[-2] == {"role": "assistant", "content": "not json at all"}
    assert "not valid JSON" in retry[-1]["content"]


@respx.mock
def test_chat_json_raises_after_second_bad_reply(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        return_value=httpx.Response(200, json=reply("[1, 2]"))
    )
    with pytest.raises(LLMParseError):
        make(settings, sleeps).chat_json([{"role": "user", "content": "x"}], SCHEMA, synthetic=True)
    assert route.call_count == 2


@respx.mock
def test_truncation_retries_with_double_budget(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        side_effect=[
            httpx.Response(200, json=reply(None, finish="length")),
            httpx.Response(200, json=reply("done")),
        ]
    )
    result = make(settings, sleeps).chat([{"role": "user", "content": "x"}], max_tokens=2000, synthetic=True)
    assert result.content == "done"
    assert [body_of(c)["max_tokens"] for c in route.calls] == [2000, 4000]


@respx.mock
def test_truncation_twice_raises_and_caps_at_8000(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        return_value=httpx.Response(200, json=reply("", finish="length"))
    )
    with pytest.raises(LLMTruncated):
        make(settings, sleeps).chat([{"role": "user", "content": "x"}], max_tokens=5000, synthetic=True)
    assert [body_of(c)["max_tokens"] for c in route.calls] == [5000, 8000]


@respx.mock
def test_truncation_at_cap_does_not_retry(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        return_value=httpx.Response(200, json=reply(None, finish="length"))
    )
    with pytest.raises(LLMTruncated):
        make(settings, sleeps).chat([{"role": "user", "content": "x"}], max_tokens=8000, synthetic=True)
    assert route.call_count == 1


@respx.mock
def test_429_and_5xx_back_off_then_succeed(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        side_effect=[
            httpx.Response(429, json={"error": {"message": "rate limited"}}),
            httpx.Response(503, text="busy"),
            httpx.Response(200, json=reply("ok")),
        ]
    )
    result = make(settings, sleeps).chat([{"role": "user", "content": "x"}], synthetic=True)
    assert result.content == "ok"
    assert route.call_count == 3
    assert sleeps == [1.0, 2.0]


@respx.mock
def test_retry_after_header_is_honored(settings, sleeps):
    respx.post(f"{settings.answer_url}/chat/completions").mock(
        side_effect=[httpx.Response(429, headers={"Retry-After": "3"}), httpx.Response(200, json=reply("ok"))]
    )
    make(settings, sleeps).chat([{"role": "user", "content": "x"}], synthetic=True)
    assert sleeps == [3.0]


@respx.mock
def test_gives_up_after_three_tries(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(return_value=httpx.Response(500))
    with pytest.raises(LLMError, match="HTTP 500"):
        make(settings, sleeps).chat([{"role": "user", "content": "x"}], synthetic=True)
    assert route.call_count == 3 and len(sleeps) == 2


@respx.mock
def test_transport_errors_are_retried(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        side_effect=[httpx.ConnectError("down"), httpx.Response(200, json=reply("ok"))]
    )
    assert make(settings, sleeps).chat([{"role": "user", "content": "x"}], synthetic=True).content == "ok"
    assert route.call_count == 2


@respx.mock
def test_client_errors_are_not_retried(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        return_value=httpx.Response(400, json={"error": {"message": "bad schema"}})
    )
    with pytest.raises(LLMError, match="bad schema"):
        make(settings, sleeps).chat([{"role": "user", "content": "x"}], synthetic=True)
    assert route.call_count == 1 and sleeps == []


@respx.mock
def test_non_json_body_is_an_llm_error(settings, sleeps):
    respx.post(f"{settings.answer_url}/chat/completions").mock(
        return_value=httpx.Response(200, text="<html>")
    )
    with pytest.raises(LLMError, match="not JSON"):
        make(settings, sleeps).chat([{"role": "user", "content": "x"}], synthetic=True)


@respx.mock
def test_health_llama_server_root(llama, sleeps):
    route = respx.get("http://127.0.0.1:8081/health").mock(
        side_effect=[
            httpx.Response(200, json={"status": "ok"}),
            httpx.Response(503),
            httpx.ConnectError("down"),
        ]
    )
    llm = make(llama, sleeps)
    assert llm.health() is True
    assert llm.health() is False
    assert llm.health() is False
    assert route.call_count == 3


@respx.mock
def test_health_openrouter(settings, sleeps):
    respx.get(f"{settings.answer_url}/key").mock(return_value=httpx.Response(200, json={"data": {}}))
    assert make(settings, sleeps).health() is True


@respx.mock
def test_llm_names_keeps_only_names_in_text(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json=reply(
                json.dumps({"names": ["Corvin Ashdale", "Wren", "Wren", "Imaginary Person", "[Student A]"]})
            ),
        )
    )
    text = "[Student A] sat with Corvin Ashdale and Wren at lunch."
    names = make(settings, sleeps).llm_names(text, synthetic=True)
    assert names == ["Corvin Ashdale", "Wren"]
    body = body_of(route.calls.last)
    assert body["response_format"]["json_schema"]["name"] == "person_names"
    assert body["messages"][-1]["content"] == text


@respx.mock
def test_llm_names_keeps_the_words_of_a_name_not_written_whole(settings, sleeps):
    found = ["Bennick Cinderfall", "Corvin Ashdal", "Imaginary Person", "Wren's"]
    respx.post(f"{settings.answer_url}/chat/completions").mock(
        return_value=httpx.Response(200, json=reply(json.dumps({"names": found})))
    )
    text = "Cinderfall, Bennick: 90 points. Corvin Ashdale revised. Wren helped."
    assert make(settings, sleeps).llm_names(text, synthetic=True) == ["Bennick", "Cinderfall", "Corvin", "Wren"]


def test_llm_names_empty_text_makes_no_call(settings, sleeps):
    assert make(settings, sleeps).llm_names("   ", synthetic=True) == []


@respx.mock
def test_request_topics_returns_listed_topics_in_policy_order(settings, sleeps):
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(
        return_value=httpx.Response(200, json=reply(json.dumps({"topics": ["full_text", "parents", "made_up"]})))
    )
    topics = {"parents": "meant for a family", "third_party": "meant for staff", "full_text": "a whole essay"}
    got = make(settings, sleeps).request_topics("Send [Student A]'s whole essay home", topics, synthetic=True)
    assert got == ["parents", "full_text"]
    body = body_of(route.calls.last)
    schema = body["response_format"]["json_schema"]
    assert schema["name"] == "request_topics"
    assert schema["schema"]["properties"]["topics"]["items"]["enum"] == list(topics)
    assert "- third_party: meant for staff" in body["messages"][0]["content"]
    assert body["messages"][-1]["content"] == "Send [Student A]'s whole essay home"


def test_request_topics_without_request_or_topics_makes_no_call(settings, sleeps):
    llm = make(settings, sleeps)
    assert llm.request_topics("  ", {"parents": "x"}, synthetic=True) == []
    assert llm.request_topics("A note home", {}, synthetic=True) == []


@pytest.mark.integration
def test_openrouter_live_tiny_call():
    real = load_settings()
    if real.glimmer_backend != "openrouter" or not real.model_api_key:
        pytest.skip("needs GLIMMER_BACKEND=openrouter and OPENROUTER_API_KEY")
    if os.environ.get("RUN_INTEGRATION") != "1":
        pytest.skip("set RUN_INTEGRATION=1")
    result = LocalLLM(real).chat(
        [{"role": "user", "content": "Reply with the single word: ready"}], max_tokens=1500, synthetic=True
    )
    assert result.content.strip()
    assert result.completion_tokens > 0


# ----- review fixes: proxies, timeouts, the name check (SEC-1, device F3, privacy F7) -----


def test_clients_ignore_proxy_settings(llama, sleeps, monkeypatch, tmp_path):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:9")
    assert make(llama, sleeps).client._mounts == {}
    from base.heavy.worker import Worker

    worker = Worker("http://127.0.0.1:8787", "t" * 32, llm=None)
    assert worker.client._mounts == {}


def test_timeout_grows_with_the_budget_on_llama_server(llama, sleeps):
    llm = make(llama, sleeps)
    assert llm.timeout_for(1500, None).read == 360
    assert llm.timeout_for(300, None).read == 120
    assert llm.timeout_for(1500, 30).read == 30
    assert llm.timeout_for(1500, None).connect == 10


@respx.mock
def test_read_timeout_is_not_retried_on_llama_server(llama, sleeps):
    route = respx.post("http://127.0.0.1:8081/v1/chat/completions").mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(LLMError):
        make(llama, sleeps).chat([{"role": "user", "content": "hi"}])
    assert route.call_count == 1


@respx.mock
def test_connect_errors_are_still_retried_on_llama_server(llama, sleeps):
    route = respx.post("http://127.0.0.1:8081/v1/chat/completions").mock(
        side_effect=[httpx.ConnectError("down"), httpx.Response(200, json=reply("ok"))]
    )
    assert make(llama, sleeps).chat([{"role": "user", "content": "hi"}]).content == "ok"
    assert route.call_count == 2


@respx.mock
def test_llm_names_keeps_names_written_with_other_apostrophes_and_spaces(llama, sleeps):
    names = ["Ms. O'Donnell", "Hunter Price", "Made Up"]
    respx.post("http://127.0.0.1:8081/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=reply(json.dumps({"names": names})))
    )
    text = "Ms. O’Donnell phoned. Hunter Price waited."
    assert make(llama, sleeps).llm_names(text) == ["Ms. O'Donnell", "Hunter Price"]
