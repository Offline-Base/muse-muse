from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from base.policy import PolicyError, UserPolicy

FIXTURE = Path(__file__).parent / "fixtures" / "policy_small.yaml"


@pytest.fixture
def policy():
    return UserPolicy.load(FIXTURE)


def item(request="", kind="free_text", topics=()):
    return {"request": request, "result_kind": kind, "topics": list(topics)}


def write(tmp_path, data):
    path = tmp_path / "p.yaml"
    path.write_text(yaml.safe_dump(data))
    return path


def test_loads_fixture(policy):
    assert policy.name == "Small test policy (invented)"
    assert set(policy.never_share) == {"iep", "medical", "discipline"}
    assert "ADHD" in policy.never_share["medical"]
    assert policy.ask_first == {"discipline"}
    assert [r.id for r in policy.rules][:2] == ["no_iep_or_medical", "no_contact_requests"]


def test_first_match_wins(policy):
    # class_aggregate would match class_averages, but the medical rule comes first
    assert policy.match(item(kind="class_aggregate", topics=["medical"])).id == "no_iep_or_medical"
    assert policy.wants(item(kind="class_aggregate", topics=["medical"])) == "refuse"
    assert policy.match(item(kind="class_aggregate")).id == "class_averages"
    assert policy.wants(item(kind="class_aggregate")) == "share_summary"


def test_request_any_is_case_insensitive_substring(policy):
    rule = policy.match(item(request="What is the family's PHONE NUMBER for [Student B]?", kind="snippet"))
    assert rule.id == "no_contact_requests"
    assert policy.match(item(request="Show me a phone-free snippet", kind="snippet")).id == "snippets"


def test_topics_all_needs_every_topic(policy):
    assert policy.match(item(kind="per_student", topics=["grades", "feedback"])).id == "graded_feedback"
    assert policy.match(item(kind="per_student", topics=["grades", "feedback", "extra"])).id == "graded_feedback"
    assert policy.match(item(kind="per_student", topics=["grades"])).id == "default"


def test_kinds_must_match(policy):
    assert policy.match(item(kind="snippet")).id == "snippets"
    assert policy.match(item(kind="free_text")).id == "default"


def test_default_and_answers(policy):
    assert policy.wants(item(kind="contact_info")) == "ask_user"
    assert policy.answer(item(kind="contact_info")) == (False, False)
    assert policy.answer(item(kind="class_aggregate")) == (True, True)
    assert policy.answer(item(topics=["iep"])) == (False, True)


def test_on_ask_defaults_from_wants(policy):
    snippets = next(r for r in policy.rules if r.id == "snippets")
    assert (snippets.approve, snippets.remember) == (True, True)


def test_pre_approved(policy):
    assert policy.pre_approved("class_aggregate", []) is True
    assert policy.pre_approved("snippet", []) is True
    assert policy.pre_approved("class_aggregate", ["iep"]) is False
    assert policy.pre_approved("per_student", ["grades", "feedback"]) is False
    # a request rule ahead of the snippet rule wins when the request is known
    assert policy.pre_approved("snippet", [], request="their home address please") is False


def test_item_can_be_an_object(policy):
    obj = SimpleNamespace(request="", result_kind="class_aggregate", topics=None)
    assert policy.wants(obj) == "share_summary"


def test_unknown_rule_key_is_a_clear_error(tmp_path):
    path = write(tmp_path, {"rules": [{"id": "r1", "kind": ["snippet"], "wants": "refuse"}]})
    with pytest.raises(PolicyError, match=r"rule 'r1'.*unknown rule keys \['kind'\]"):
        UserPolicy.load(path)


def test_unknown_decision_is_a_clear_error(tmp_path):
    path = write(tmp_path, {"rules": [{"id": "r1", "wants": "share_all"}]})
    with pytest.raises(PolicyError, match="wants must be one of"):
        UserPolicy.load(path)
    path = write(tmp_path, {"default": {"wants": "maybe"}})
    with pytest.raises(PolicyError, match="default: wants must be one of"):
        UserPolicy.load(path)


@pytest.mark.parametrize(
    "data, message",
    [
        ({"rules": [{"id": "r", "kinds": ["essay"], "wants": "refuse"}]}, "unknown kinds"),
        ({"rules": [{"id": "r", "wants": "ask_user", "pre_approved": True}]}, "pre_approved only"),
        ({"rules": [{"id": "r", "wants": "refuse", "on_ask": {"approve": "yes"}}]}, "true or false"),
        ({"rules": [{"id": "r", "wants": "refuse", "on_ask": {"agree": True}}]}, "unknown on_ask keys"),
        ({"rules": [{"id": "r", "wants": "refuse", "topics_any": "iep"}]}, "list of non-empty strings"),
        ({"rules": [{"id": "r", "wants": "refuse"}, {"id": "r", "wants": "refuse"}]}, "appears twice"),
        ({"rules": [{"id": "r"}]}, "wants is required"),
        ({"never_share": {"iep": ["IEP"]}, "ask_first": ["medical"]}, "not in never_share"),
        ({"never_share": ["iep"]}, "never_share must map"),
        ({"rulez": []}, "unknown top-level keys"),
        ({"default": {"wants": "refuse", "why": "x"}}, "default: unknown keys"),
    ],
)
def test_validation_errors(tmp_path, data, message):
    with pytest.raises(PolicyError, match=message):
        UserPolicy.load(write(tmp_path, data))


def test_bad_yaml(tmp_path):
    path = tmp_path / "bad.yaml"
    path.write_text("rules: [\n")
    with pytest.raises(PolicyError, match="not valid YAML"):
        UserPolicy.load(path)


def test_empty_policy_defaults_to_ask_user(tmp_path):
    policy = UserPolicy.load(write(tmp_path, {"name": "empty"}))
    assert policy.wants(item(kind="per_student")) == "ask_user"
    assert policy.never_share == {}
    assert policy.ask_first == set()


def _with_topics(request_topics, never_share=None):
    return {"never_share": never_share or {"iep": ["IEP"]}, "request_topics": request_topics, "rules": []}


def test_request_topics_load_with_collapsed_whitespace():
    policy = UserPolicy.from_dict(_with_topics({"parents": "  meant for\n a family  ", "class_level": "a class question"}))
    assert policy.request_topics == {"parents": "meant for a family", "class_level": "a class question"}


@pytest.mark.parametrize(
    "bad",
    [
        {"iep": "already a never-share topic"},
        {"Third Party": "names are lowercase words"},
        {"parents": ""},
        {"parents": ["a list, not a description"]},
        ["parents"],
    ],
)
def test_bad_request_topics_are_refused(bad):
    with pytest.raises(PolicyError):
        UserPolicy.from_dict(_with_topics(bad))


def test_eval_policy_request_topics_are_described():
    policy = UserPolicy.load(Path(__file__).parent.parent / "eval" / "user_policy.yaml")
    assert set(policy.request_topics) == {"parents", "third_party", "full_text", "deanonymize", "class_level"}
    assert "reidentify" not in policy.request_topics  # left to the router's first step


def test_identifier_topics_map_an_identifier_to_a_never_share_topic():
    p = UserPolicy.from_dict({"never_share": {"parent_contact": ["phone number"]},
                              "identifier_topics": {"phone": "parent_contact", "email": "parent_contact"}})  # fmt: skip
    assert p.identifier_topics == {"phone": "parent_contact", "email": "parent_contact"}
    p.identifier_topics["phone"] = "changed"  # a copy
    assert p.identifier_topics["phone"] == "parent_contact"
    assert UserPolicy.from_dict({}).identifier_topics == {}


@pytest.mark.parametrize(
    ("bad", "message"),
    [
        ({"phone": "grades"}, "never_share topic"),
        ({"shoe_size": "parent_contact"}, "identifier_topics kinds"),
        (["phone"], "must map"),
    ],
)
def test_bad_identifier_topics_are_refused(bad, message):
    with pytest.raises(PolicyError, match=message):
        UserPolicy.from_dict({"never_share": {"parent_contact": ["phone number"]}, "identifier_topics": bad})


def test_eval_policy_counts_contact_identifiers_as_never_share_topics():
    p = UserPolicy.load(Path(__file__).parents[1] / "eval" / "user_policy.yaml")
    assert p.identifier_topics == {"phone": "parent_contact", "email": "parent_contact", "address": "home_address"}
