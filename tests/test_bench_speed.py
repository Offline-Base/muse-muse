"""scripts/bench_speed.py: the request-topics step matches the call egress makes. Mocked model (respx)."""

from __future__ import annotations

import json

import httpx
import respx

from base.local_llm import LocalLLM
from base.policy import UserPolicy
from scripts import bench_speed


@respx.mock
def test_bench_topics_step_sends_what_the_device_sends(settings, tmp_path):
    # The bench's request-topics call is the one egress makes: same prompt, policy topics and schema.
    reply = {"choices": [{"message": {"content": '{"topics": ["parents"]}'}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 300, "completion_tokens": 150}}  # fmt: skip
    route = respx.post(f"{settings.answer_url}/chat/completions").mock(return_value=httpx.Response(200, json=reply))
    llm = LocalLLM(settings, "answer")
    assert bench_speed.main(["--label", "cloud", "--runs", "1", "--out", str(tmp_path)], settings=settings, llm=llm) == 0
    topics = UserPolicy.load(settings.policy_path).request_topics
    bench = [json.loads(c.request.content) for c in route.calls]
    [topic_call] = [b for b in bench if b["response_format"]["json_schema"]["name"] == "request_topics"]
    assert llm.request_topics(bench_speed.DEMO_REQUEST, topics, synthetic=True) == ["parents"]
    device = json.loads(route.calls[-1].request.content)
    assert topic_call == device and list(topics) == topic_call["response_format"]["json_schema"]["schema"][
        "properties"]["topics"]["items"]["enum"]  # fmt: skip
    assert "| Request topics |" in (tmp_path / "cloud_speed.md").read_text()


def test_bench_leaves_out_the_topics_step_without_request_topics():
    assert "Request topics" not in bench_speed.step_messages(topics={})
    assert list(bench_speed.step_messages(topics={"parents": "for families"})) == list(bench_speed.STEPS)
