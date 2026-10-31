"""The FERPA, COPPA and HIPAA toggles: what they tag, lock and hold. Everything here is invented."""

from __future__ import annotations

from pathlib import Path

import pytest

from base import compliance, guard
from base.approvals import AutoApprove
from base.config import load_settings
from base.controls import Controls, ControlStore
from base.egress import Egress
from base.guard import Redaction, TagMap, load_roster
from base.services import Services

ROSTER = load_roster(Path(__file__).parent / "fixtures" / "guard_roster.json")
ALL = Redaction(extra_kinds=compliance.extra_kinds(["hipaa"]))


def tagged(text):
    return guard.tag(text, ROSTER, TagMap(None), redaction=ALL)


@pytest.mark.parametrize(
    ("kind", "value", "text"),
    [
        ("date", "March 4, 2026", "Admitted on March 4, 2026 for review."),
        ("date", "3/4/2026", "Seen 3/4/2026 at noon."),
        ("date", "2026-03-04", "Visit date 2026-03-04 was moved."),
        ("date", "March 2026", "Discharged in March 2026 with notes."),
        ("age", "93", "The resident is 93 years old."),
        ("age", "91", "Aged 91 and doing well."),
        ("url", "https://portal.example.org/chart/77", "See https://portal.example.org/chart/77 for more."),
        ("url", "www.example.com", "Posted on www.example.com today."),
        ("ip", "192.0.2.14", "Logged in from 192.0.2.14 yesterday."),
        ("record", "MR-448812", "Her MRN: MR-448812 is on file."),
        ("record", "PLN77821", "health plan number PLN77821 is active"),
        ("record", "ACCT-9921", "account number ACCT-9921 was closed"),
        ("record", "D1234567", "driver's license D1234567 expired"),
        ("record", "1HGCM82633A004352", "the car's 1HGCM82633A004352 was noted"),
        ("record", "00:1B:44:11:3A:B7", "device 00:1B:44:11:3A:B7 paired"),
        ("place", "78701", "They live in 78701 now."),
        ("place", "Coral Bay, TX", "They moved to Coral Bay, TX last year."),
        ("detail", "Quillmere Elementary", "She attends Quillmere Elementary with friends."),
        ("detail", "Ashgrove Hospital", "He works at Ashgrove Hospital on weekends."),
        ("detail", "Vosberghs", "We met the Vosberghs after class."),
    ],
)
def test_each_kind_is_tagged_and_the_leak_check_catches_it(kind, value, text):
    result = tagged(text)
    assert value not in result.text, result.text
    assert kind in {h.kind for h in result.hits}
    assert guard.restore(result.text, result.tag_map) == text
    assert kind in {h.kind for h in guard.leaks(text, ROSTER, TagMap(None), ALL)}
    assert guard.leaks(result.text, ROSTER, TagMap(None), ALL) == []  # and tagging is stable


def test_the_default_output_is_unchanged():
    text = "Seen March 4, 2026 at Ashgrove Hospital, https://example.org, MRN 448812 in 78701."
    out = guard.tag(text, ROSTER, TagMap(None)).text
    assert "March 4, 2026" in out and "Ashgrove Hospital" in out and "78701" in out


@pytest.mark.parametrize(
    "text",
    [
        "The class improved on Monday in reading and writing.",
        "Most of the students finished the rubric by Friday.",
        "Reading scores rose. Grades in math stayed the same.",
        "The IEP meeting is in March.",
        "The year 2026 was a good year.",
        "The group is in Room 14 on the second floor.",
        "The plan is to meet at 3 after lunch.",
        "Held on your device.",
        "The device has 12 hours of battery.",
    ],
)
def test_ordinary_sentences_stay_readable(text):
    assert tagged(text).text == text


def test_what_a_toggle_tagged_stops_counting_when_the_toggle_is_off():
    tm = TagMap(None)
    assert "Ashgrove" not in guard.tag("He works at Ashgrove Hospital.", ROSTER, tm, redaction=ALL).text
    assert "[Detail 1]" in guard.tag("Ashgrove Hospital called.", ROSTER, tm, redaction=ALL).text
    assert "Ashgrove Hospital" in guard.tag("Ashgrove Hospital called.", ROSTER, tm).text
    assert guard.leaks("Ashgrove Hospital called.", ROSTER, tm) == []
    assert guard.leaks("Ashgrove Hospital called.", ROSTER, tm, ALL) != []


def test_tags_for_new_kinds_are_restored_only_in_brackets():
    tm = TagMap(None)
    t = tm.tag_for("age", "93", "93")
    assert t == "[Age 1]"
    assert guard.restore("Is [Age 1] right? Age 1 groups meet Tuesday.", tm) == "Is 93 right? Age 1 groups meet Tuesday."


# locks


def test_a_toggle_ignores_the_users_opt_outs_but_keeps_always_redact():
    c = Controls(
        tag_kinds={"phone": False}, never_redact=["Ashgrove Hospital"], always_redact=["Secret Word"],
        names_off_folders=["resumes"], profiles=["ferpa"],
    )
    r = c.redaction(["resumes/a.pdf"])
    assert r.names and not r.skip_kinds and not r.never and r.always == ("Secret Word",)
    assert {"date", "place", "detail", "record", "url", "ip"} <= r.extra_kinds and "age" not in r.extra_kinds
    assert "age" in Controls(profiles=["ferpa", "hipaa"]).redaction().extra_kinds


def test_only_known_toggles_are_kept_and_retention_comes_from_the_toggle():
    assert Controls.from_dict({"profiles": ["HIPAA", "bogus", "ferpa"]}).profiles == ["ferpa", "hipaa"]
    assert compliance.retention_days(["ferpa"]) is None and compliance.retention_days(["coppa", "ferpa"]) == 90
    assert compliance.retention_days(["gdpr"]) == 90


@pytest.mark.parametrize("key", ["cui", "cjis", "export"])
def test_government_toggles_keep_everything_on_the_device(key):
    assert compliance.local_only([key])
    assert compliance.check("The class improved.", [], [key])[:2] == ("refuse", "compliance:local_only")


@pytest.mark.parametrize(
    ("key", "text", "decision", "floor"),
    [
        ("part2", "Started methadone last week.", "refuse", "compliance:sensitive"),
        ("pci", "The CVV is on the back.", "refuse", "compliance:sensitive"),
        ("tax", "Her tax return was filed.", "refuse", "compliance:sensitive"),
        ("legal", "This memo is privileged.", "refuse", "compliance:sensitive"),
        ("legal", "Plain notes on the schedule.", "ask_user", "compliance:ask_all"),
        ("gdpr", "Notes on religion in the survey.", "refuse", "compliance:sensitive"),
        ("glba", "Her credit score rose.", "ask_user", "compliance:ask_word"),
        ("hr", "His performance review is done.", "ask_user", "compliance:ask_word"),
        ("ccpa", "Precise geolocation was collected.", "ask_user", "compliance:ask_word"),
    ],
)
def test_each_toggles_words_hold_a_result(key, text, decision, floor):
    assert compliance.check(text, [], [key])[:2] == (decision, floor)


def test_a_plain_result_passes_a_word_toggle_and_a_tagged_keyword_still_counts():
    assert compliance.check("The class improved.", [], ["glba", "hr", "tax"]) is None
    assert compliance.check("[Detail 1] was filed.", [], ["tax"], raw="Tax Return was filed.")[0] == "refuse"


def test_the_strictest_toggle_wins():
    assert compliance.check("Her credit score rose.", [], ["glba", "cui"])[1] == "compliance:local_only"
    assert compliance.check("Started methadone, credit score fell.", [], ["glba", "part2"])[0] == "refuse"


def test_every_toggle_says_what_it_cannot_do_and_never_claims_compliance():
    for p in compliance.PROFILES.values():
        assert p.does and p.limit and p.group in compliance.GROUPS
        assert "compliant" not in f"{p.does} {p.limit}".lower()
        assert "\u2014" not in f"{p.does} {p.limit}"


# holds


@pytest.mark.parametrize(
    "text",
    [
        "Three students missed the test.",
        "3 of 24 students missed it.",
        "2 out of 18 failed.",
        "Only 4 patients came back.",
        "Results (n = 7) were mixed.",
        "A few students missed it.",
    ],
)
def test_small_groups_are_found(text):
    assert compliance.describes_small_group(text)


@pytest.mark.parametrize(
    "text",
    [
        "12 of 24 students passed.", "The class of 24 students improved.", "Scores rose 3 points.", "n = 30 in total",
        "0 of 24 students failed.", "She wrote about bees and scored 3 of 4.", "He earned 3 of 20 on the quiz.", "Got 8 of 10 points.",
    ],
)
def test_larger_groups_are_not(text):
    assert not compliance.describes_small_group(text)


def test_check_is_quiet_without_a_toggle():
    assert compliance.check("Three students missed it.", ["a.png"], []) is None
    assert compliance.check("Three students missed it.", [], ["ferpa"])[0] == "refuse"
    assert compliance.check("The class improved.", ["scans/a.png"], ["ferpa"])[0] == "ask_user"


# egress


class _Llm:
    is_cloud = False

    def __init__(self, decision="share_summary"):
        self.decision = decision

    def chat_json(self, *_a, **_k):
        return {"decision": self.decision, "reason": "because"}

    def chat(self, *_a, **_k):
        return type("R", (), {"content": "The class improved overall."})()

    def llm_names(self, *_a, **_k):
        return []

    def request_topics(self, *_a, **_k):
        return []


def services_for(tmp_path, profiles, *, device_only=True):
    root = tmp_path / "w"
    root.mkdir(exist_ok=True)
    (root / ".synthetic").write_text("invented\n")
    env = {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(root), "CHECKER_API_KEY": "k", "OPENROUTER_API_KEY": "k"}
    if device_only:
        env["DEVICE_ONLY"] = "1"
    svc = Services.create(load_settings(env), light=False, heavy=False, owner=False)
    ControlStore(svc.settings.paths.controls).save(Controls(profiles=profiles))
    svc.router.llm = svc.checker_llm = svc.answer_llm = _Llm()
    return svc


def test_the_wider_model_pass_runs_only_with_a_toggle_on(tmp_path):
    class Pass(_Llm):
        def __init__(self):
            super().__init__()
            self.calls = []

        def llm_names(self, *_a, **_k):
            self.calls.append("names")
            return []

        def llm_details(self, *_a, **_k):
            self.calls.append("details")
            return ["larkspur heights"]

    svc = services_for(tmp_path, ["ferpa"])
    try:
        svc.checker_llm = checker = Pass()
        out = Egress(svc).release("search_documents", "for my records", "they moved to larkspur heights.", "class_aggregate", summary="they moved to larkspur heights.")
        assert checker.calls and set(checker.calls) == {"details"} and "larkspur" not in out.text
        checker.calls.clear()
        ControlStore(svc.settings.paths.controls).save(Controls())
        Egress(svc).release("search_documents", "for my records", "Notes.", "class_aggregate", summary="Notes.")
        assert set(checker.calls) == {"names"}
    finally:
        svc.close()


def test_a_toggle_tags_more_on_the_way_out_and_at_the_final_check(tmp_path):
    svc = services_for(tmp_path, ["ferpa"])
    try:
        out = Egress(svc).release(
            "search_documents", "notes for my records", "On March 4, 2026 the class visited Ashgrove Hospital.", "class_aggregate",
            summary="On March 4, 2026 the class visited Ashgrove Hospital.",
        )
        assert out.status == "shared" and "Ashgrove" not in out.text and "March 4" not in out.text
    finally:
        svc.close()


def test_a_small_group_is_kept_with_a_fixed_reason(tmp_path):
    svc = services_for(tmp_path, ["ferpa"])
    try:
        out = Egress(svc).release("search_documents", "for my records", "Three students missed the test.", "class_aggregate", summary="Three students missed the test.")
        assert out.status == "refused" and "fewer than 10 people" in out.text and "missed" not in out.text
    finally:
        svc.close()


def test_a_summary_that_narrows_to_a_small_group_is_kept(tmp_path):
    svc = services_for(tmp_path, ["hipaa"])
    try:
        out = Egress(svc).release("search_documents", "for my records", "The class of 24 improved.", "class_aggregate", summary="Two patients improved.")
        assert out.status == "refused"
    finally:
        svc.close()


def test_a_scan_waits_for_the_user(tmp_path):
    svc = services_for(tmp_path, ["coppa"])
    try:
        out = Egress(svc).release("read_document", "for my records", "The class improved.", "snippet", sources=["scans/a.png"])
        assert out.status == "waiting"
    finally:
        svc.close()


def test_always_approve_does_nothing_while_a_toggle_is_on(tmp_path):
    svc = services_for(tmp_path, ["hipaa"])
    try:
        AutoApprove(svc.settings.paths.auto_approve).set(True)
        out = Egress(svc).release("search_documents", "for my records", "Plain notes about tide pools.", "snippet")
        assert out.status == "waiting"
    finally:
        svc.close()


def test_a_toggle_without_device_only_keeps_everything_on_the_device(tmp_path):
    svc = services_for(tmp_path, ["ferpa"], device_only=False)
    try:
        out = Egress(svc).release("search_documents", "for my records", "Plain notes.", "snippet")
        assert out.status == "refused" and "every model on this device" in out.text and "notes" not in out.text
    finally:
        svc.close()


def test_a_government_toggle_sends_nothing_to_muse_and_gives_a_plain_reason(tmp_path):
    svc = services_for(tmp_path, ["cui"])
    try:
        for kind in ("document_list", "class_aggregate", "snippet"):
            out = Egress(svc).release("search_documents", "for my records", "The class improved.", kind, summary="The class improved.")
            assert out.status == "refused" and "keeps everything on this device" in out.text and "improved" not in out.text
    finally:
        svc.close()


def test_a_broken_controls_file_turns_every_toggle_on(tmp_path):
    svc = services_for(tmp_path, [])
    try:
        svc.settings.paths.controls.write_text("{broken")
        svc.controls = ControlStore(svc.settings.paths.controls)
        out = Egress(svc).release(
            "search_documents", "for my records", "Visited Ashgrove Hospital.", "class_aggregate", summary="Visited Ashgrove Hospital."
        )
        assert out.status == "refused" and "Ashgrove" not in out.text
    finally:
        svc.close()
