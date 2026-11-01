import json
import os
import re
import sqlite3
import sys
import types

import httpx
import pytest
import respx

from base.config import load_settings
from base.spark import Spark, SparkError, SparkRefused, SparkResult, usage_summary
from base.types import Hit, Person, Roster

ROSTER = Roster(
    teacher=Person("Odessa Brightwater", "Odessa", "Brightwater", role="teacher"),
    students=(
        Person("Quillon Marsh", "Quillon", "Marsh", nicknames=("Quill",), student_id="S700101"),
        Person("Tavi Rendleman", "Tavi", "Rendleman"),
    ),
)
PHONE = re.compile(r"\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")


def fake_checker(text):
    """A tiny stand-in for base.guard: roster names plus phone numbers."""
    hits = []
    for person in ROSTER.people():
        for word in (person.first, person.last, *person.nicknames):
            for m in re.finditer(rf"\b{re.escape(word)}\b", text):
                hits.append(Hit("student", m.group(0), m.start(), m.end()))
    for m in PHONE.finditer(text):
        hits.append(Hit("phone", m.group(0), m.start(), m.end()))
    return hits


def reply(content='{"ok": true}', *, finish="stop"):
    return {
        "id": "r1",
        "model": "muse-spark-1.3",
        "choices": [
            {"index": 0, "finish_reason": finish, "message": {"role": "assistant", "content": content}}
        ],
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 30,
            "total_tokens": 130,
            "completion_tokens_details": {"reasoning_tokens": 12},
            "prompt_tokens_details": {"cached_tokens": 64},
        },
    }


@pytest.fixture
def sleeps():
    return []


@pytest.fixture
def spark(settings, tmp_path, sleeps):
    return Spark(
        settings, checker=fake_checker, cache_path=tmp_path / "cache" / "spark.db", sleep=sleeps.append
    )


def url(settings):
    return f"{settings.spark_base}/chat/completions"


MSG = [{"role": "user", "content": "Write one invented spelling list for a 4th-grade class."}]
SCHEMA = {
    "type": "object",
    "properties": {"ok": {"type": "boolean"}},
    "required": ["ok"],
    "additionalProperties": False,
}


@respx.mock
def test_request_body_and_auth(settings, spark):
    route = respx.post(url(settings)).mock(return_value=httpx.Response(200, json=reply()))
    result = spark.chat(MSG, max_tokens=900, json_schema=SCHEMA, effort="low")
    assert isinstance(result, SparkResult) and result.content == '{"ok": true}' and not result.cached
    assert result.usage["completion_tokens_details"]["reasoning_tokens"] == 12
    request = route.calls.last.request
    assert request.headers["authorization"] == "Bearer test-meta-key"
    body = json.loads(request.content)
    assert body["model"] == "muse-spark-1.3"
    assert body["reasoning_effort"] == "low"
    assert body["max_tokens"] == 900
    assert body["messages"] == MSG
    assert body["response_format"]["type"] == "json_schema"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert body["response_format"]["json_schema"]["schema"] == SCHEMA


def test_effort_none_is_rejected(spark):
    with pytest.raises(ValueError):
        spark.build_body(MSG, effort="none")
    assert spark.build_body(MSG)["reasoning_effort"] == "minimal"


def test_refuses_roster_name(settings, spark):
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(url(settings)).mock(return_value=httpx.Response(200, json=reply()))
        with pytest.raises(SparkRefused) as info:
            spark.chat([{"role": "user", "content": "Summarize Quill's reading log."}])
        assert not route.called
    assert "Quill" not in str(info.value) and "student" in str(info.value)


def test_refuses_phone_number(settings, spark):
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(url(settings)).mock(return_value=httpx.Response(200, json=reply()))
        msgs = [
            {"role": "system", "content": "You write invented data."},
            {"role": "user", "content": [{"type": "text", "text": "Call (512) 555-0143 about the trip."}]},
        ]
        with pytest.raises(SparkRefused, match="phone"):
            spark.chat(msgs)
        assert not route.called


def test_default_checker_uses_guard_with_roster(settings, tmp_path, monkeypatch):
    seen = {}

    def find_names(text, roster):
        seen["roster"] = roster
        return [h for h in fake_checker(text) if h.kind == "student"]

    fake_guard = types.SimpleNamespace(find_identifiers=lambda text: [], find_names=find_names)
    monkeypatch.setitem(sys.modules, "base.guard", fake_guard)
    spark = Spark(settings, roster=ROSTER, cache_path=tmp_path / "s.db")
    with pytest.raises(SparkRefused):
        spark.check([{"role": "user", "content": "Grade Tavi Rendleman's essay."}])
    spark.check([{"role": "user", "content": "Grade [Student B]'s essay."}])
    assert seen["roster"] is ROSTER


def test_default_checker_fails_closed_without_guard(settings, tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "base.guard", None)
    spark = Spark(settings, cache_path=tmp_path / "s.db")
    with pytest.raises(SparkRefused, match="unavailable"):
        spark.check(MSG)


@respx.mock
def test_second_identical_call_hits_cache(settings, spark):
    route = respx.post(url(settings)).mock(return_value=httpx.Response(200, json=reply()))
    first = spark.chat(MSG, effort="low")
    second = spark.chat(MSG, effort="low")
    assert route.call_count == 1
    assert not first.cached and second.cached
    assert second.content == first.content and second.usage == first.usage
    spark.chat(MSG, effort="medium")
    assert route.call_count == 2
    spark.chat(MSG, effort="low", cache=False)
    assert route.call_count == 3


@respx.mock
def test_token_accounting_rows_and_summary(settings, spark):
    respx.post(url(settings)).mock(return_value=httpx.Response(200, json=reply()))
    spark.chat(MSG)
    spark.chat(MSG)
    conn = sqlite3.connect(spark.cache_path)
    rows = conn.execute(
        "SELECT model, prompt_tokens, completion_tokens, reasoning_tokens, cached, cached_tokens"
        " FROM spark_calls ORDER BY rowid"
    ).fetchall()
    conn.close()
    assert rows == [("muse-spark-1.3", 100, 30, 12, 0, 64), ("muse-spark-1.3", 100, 30, 12, 1, 64)]
    summary = spark.usage_summary()
    assert summary == {
        "calls": 2,
        "api_calls": 1,
        "cache_hits": 1,
        "prompt_tokens": 100,
        "completion_tokens": 30,
        "reasoning_tokens": 12,
        "cached_prompt_tokens": 64,
    }


def test_usage_summary_without_db(tmp_path):
    assert usage_summary(tmp_path / "missing.db")["calls"] == 0


@respx.mock
def test_truncated_reply_is_not_cached(settings, spark):
    route = respx.post(url(settings)).mock(
        return_value=httpx.Response(200, json=reply('{"ok": tr', finish="length"))
    )
    assert spark.chat(MSG).finish_reason == "length"
    spark.chat(MSG)
    assert route.call_count == 2


@respx.mock
def test_429_backoff(settings, spark, sleeps):
    route = respx.post(url(settings)).mock(
        side_effect=[httpx.Response(429), httpx.Response(502), httpx.Response(200, json=reply())]
    )
    assert spark.chat(MSG).content
    assert route.call_count == 3 and sleeps == [1.0, 2.0]


@respx.mock
def test_errors_raise_spark_error(settings, spark):
    respx.post(url(settings)).mock(return_value=httpx.Response(401, json={"error": {"message": "bad key"}}))
    with pytest.raises(SparkError, match="401"):
        spark.chat(MSG)


@respx.mock
def test_chat_json_parses(settings, spark):
    respx.post(url(settings)).mock(return_value=httpx.Response(200, json=reply('{"ok": true}')))
    assert spark.chat_json(MSG, SCHEMA) == {"ok": True}


def test_missing_key_is_an_error(tmp_path):
    s = load_settings({"BASE_HOME": str(tmp_path / "h"), "META_API_KEY": ""})
    spark = Spark(s, checker=lambda text: [], cache_path=tmp_path / "s.db")
    with pytest.raises(SparkError, match="META_API_KEY"):
        spark.chat(MSG)


def test_no_files_until_first_call(settings, tmp_path):
    path = tmp_path / "lazy" / "spark.db"
    Spark(settings, checker=lambda text: [], cache_path=path).build_body(MSG)
    assert not path.exists()


@pytest.mark.integration
def test_spark_live_tiny_call(tmp_path):
    real = load_settings()
    if not real.meta_api_key:
        pytest.skip("needs META_API_KEY")
    if os.environ.get("RUN_INTEGRATION") != "1":
        pytest.skip("set RUN_INTEGRATION=1")
    spark = Spark(real, checker=lambda text: [], cache_path=tmp_path / "spark.db")
    data = spark.chat_json(
        [{"role": "user", "content": 'Reply with JSON {"ok": true}.'}],
        SCHEMA,
        max_tokens=300,
        effort="minimal",
        cache=False,
    )
    assert data == {"ok": True}
    assert spark.usage_summary()["api_calls"] == 1
